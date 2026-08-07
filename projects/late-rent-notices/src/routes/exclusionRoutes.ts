import { Router, type Response } from "express";
import { z } from "zod";
import { withPmScope } from "../db/withPmScope.js";
import { requireSession, type AuthedRequest } from "./requireSession.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace } from "../lib/trace.js";

export const exclusionRoutes = Router();
exclusionRoutes.use(requireSession);

exclusionRoutes.get("/api/exclusions", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const exclusions = await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query(
      `SELECT e.id, e.reason, e.reason_category, e.active, e.created_at,
              l.unit_label
       FROM exclusions e
       JOIN leases l ON l.id = e.lease_id
       WHERE e.active = true
       ORDER BY e.created_at DESC`
    );
    return result.rows;
  });
  res.json({ exclusions });
}));

const createExclusionSchema = z.object({
  leaseId: z.number().int().positive(),
  reasonCategory: z.enum(["payment_plan", "dispute", "active_eviction", "other"]),
  reason: z.string().min(5),
});

// Owner/fallback-decision-maker only (Jason, 2026-08-07): excluding a
// lease from automatic notices — permanently, across every future month
// until someone removes it — is a bigger decision than a regular PM
// should make unilaterally on their own door. Server-side check, not just
// a hidden UI button: migration 0053 gave the fallback role RLS access to
// any lease's exclusions/late_cycles specifically so this check has
// something to actually authorize once it passes.
function requireFallbackDecisionMaker(session: { isFallbackDecisionMaker: boolean }, res: Response): boolean {
  if (!session.isFallbackDecisionMaker) {
    res.status(403).json({ error: "Only the owner can exclude a lease from automatic notices." });
    return false;
  }
  return true;
}

exclusionRoutes.post("/api/exclusions", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  if (!requireFallbackDecisionMaker(session, res)) return;
  const parsed = createExclusionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid exclusion request.", details: parsed.error.flatten() });
    return;
  }

  const exclusion = await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query<{ id: number }>(
      `INSERT INTO exclusions (lease_id, source, reason, reason_category, added_by_pm_id)
       VALUES ($1, 'manual', $2, $3, $4) RETURNING id`,
      [parsed.data.leaseId, parsed.data.reason, parsed.data.reasonCategory, session.pmUserId]
    );

    const trace = startTrace();
    await writeAuditLog(client, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      actorType: "fallback_decision_maker",
      actorId: String(session.pmUserId),
      eventType: "exclusion.created",
      eventSummary: `Owner added a manual exclusion (category: ${parsed.data.reasonCategory})`,
      eventData: { reasonCategory: parsed.data.reasonCategory },
      contextSnapshot: { leaseId: parsed.data.leaseId },
      privacyCategory: "Decisional Interference",
      regulationTags: [],
      riskLevel: "low",
      legalBasis: "manual_exclusion_list",
      retentionPolicy: "retain_7_years_post_tenancy",
      trace,
    });

    // An exclusion only stops FUTURE late_cycles from being created
    // (dailyLatenessCheck.ts checks it before drafting) — it does nothing
    // about a cycle that's already open with no notice, which would
    // otherwise keep sitting in "Late, No Notice Yet" forever. Closing it
    // here makes "exclude this" a genuinely complete action: gone now,
    // and never comes back on its own.
    const closedCycles = await client.query<{ id: number }>(
      `UPDATE late_cycles SET closed_at = now(), closed_reason = 'manual'
       WHERE lease_id = $1 AND closed_at IS NULL
       RETURNING id`,
      [parsed.data.leaseId]
    );
    if (closedCycles.rows.length > 0) {
      await writeAuditLog(client, {
        companyId: "limehouse-pm",
        instanceId: "late-rent-notices",
        actorType: "fallback_decision_maker",
        actorId: String(session.pmUserId),
        eventType: "late_cycle.closed",
        eventSummary: `${closedCycles.rows.length} open late cycle(s) closed as part of a manual exclusion`,
        eventData: { closedCycleIds: closedCycles.rows.map((r) => r.id) },
        contextSnapshot: { leaseId: parsed.data.leaseId },
        privacyCategory: "Aggregation",
        regulationTags: ["VRLTA"],
        riskLevel: "low",
        legalBasis: "manual_exclusion_list",
        retentionPolicy: "retain_7_years_post_tenancy",
        trace,
      });
    }

    return result.rows[0];
  });

  res.status(201).json(exclusion);
}));

exclusionRoutes.post("/api/exclusions/:id/remove", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  if (!requireFallbackDecisionMaker(session, res)) return;
  const exclusionId = Number(req.params.id);
  if (!Number.isInteger(exclusionId) || exclusionId <= 0) {
    res.status(400).json({ error: "Invalid exclusion id." });
    return;
  }

  await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query<{ id: number; lease_id: number; reason_category: string }>(
      `UPDATE exclusions SET active = false, removed_by_pm_id = $1, removed_at = now()
       WHERE id = $2 AND active = true
       RETURNING id, lease_id, reason_category`,
      [session.pmUserId, exclusionId]
    );

    // Only log a removal if a row was actually active and got deactivated —
    // an unknown/already-removed id is a no-op, not a real event.
    if (result.rows.length > 0) {
      const removed = result.rows[0];
      const trace = startTrace();
      await writeAuditLog(client, {
        companyId: "limehouse-pm",
        instanceId: "late-rent-notices",
        actorType: "fallback_decision_maker",
        actorId: String(session.pmUserId),
        eventType: "exclusion.removed",
        eventSummary: `Owner removed exclusion ${removed.id} (category: ${removed.reason_category})`,
        eventData: { reasonCategory: removed.reason_category },
        contextSnapshot: { leaseId: removed.lease_id, exclusionId: removed.id },
        privacyCategory: "Decisional Interference",
        regulationTags: [],
        riskLevel: "low",
        legalBasis: "manual_exclusion_list",
        retentionPolicy: "retain_7_years_post_tenancy",
        trace,
      });
    }
  });
  res.status(204).end();
}));
