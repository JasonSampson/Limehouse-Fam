import { Router } from "express";
import { z } from "zod";
import { withPmScope } from "../db/withPmScope.js";
import { requireSession, type AuthedRequest } from "./requireSession.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace } from "../lib/trace.js";

export const leaseRoutes = Router();
leaseRoutes.use(requireSession);

// Grace period is NOT one company-wide number (Jason: leases inherited
// from a prior management company often carry a different late-fee policy
// than Limehouse's own standard) — it's tracked per-lease, defaulted on
// first Buildium sync, and overridable here by the assigned PM. RLS on
// `leases` (migration 0016) already scopes this to leases on properties
// the signed-in PM is assigned to — no separate ownership check needed.
leaseRoutes.get("/api/leases", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const leases = await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query(
      // p.is_active = true: this is the PM's working lease list (used to
      // pick a lease to override a grace period on), not a historical
      // lookup — a lease surviving on a property that's sold/inactive in
      // Buildium shouldn't appear as something to manage going forward.
      `SELECT l.id, l.unit_label, l.rent_due_day, l.grace_period_days, l.lease_status,
              p.name AS property_name
       FROM leases l
       JOIN properties p ON p.id = l.property_id
       WHERE l.lease_status = 'Active' AND p.is_active = true
       ORDER BY p.name, l.unit_label`
    );
    return result.rows;
  });
  res.json({ leases });
}));

const gracePeriodSchema = z.object({
  gracePeriodDays: z.number().int().min(0).max(60),
  reason: z.string().min(5),
});

leaseRoutes.patch("/api/leases/:id/grace-period", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const leaseId = Number(req.params.id);
  const parsed = gracePeriodSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "A grace period (0-60 days) and a reason (5+ characters) are required.",
      details: parsed.error.flatten(),
    });
    return;
  }

  const updated = await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query(
      "UPDATE leases SET grace_period_days = $1 WHERE id = $2 RETURNING id, grace_period_days",
      [parsed.data.gracePeriodDays, leaseId]
    );
    if (result.rows.length === 0) {
      return null;
    }

    const trace = startTrace();
    await writeAuditLog(client, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      actorType: "pm",
      actorId: String(session.pmUserId),
      eventType: "lease.grace_period_overridden",
      eventSummary: `PM set grace period for lease ${leaseId} to ${parsed.data.gracePeriodDays} days: ${parsed.data.reason}`,
      eventData: { gracePeriodDays: parsed.data.gracePeriodDays, reason: parsed.data.reason },
      contextSnapshot: { leaseId },
      privacyCategory: "N/A",
      regulationTags: [],
      riskLevel: "medium",
      legalBasis: "per_lease_late_fee_policy",
      retentionPolicy: "retain_7_years_post_tenancy",
      trace,
    });

    return result.rows[0];
  });

  if (!updated) {
    // RLS (or a nonexistent lease id) means this PM can't act on this
    // lease — same "not visible to you" framing as noticeRoutes.ts uses.
    res.status(404).json({ error: "Lease not found or not visible to you." });
    return;
  }

  res.json(updated);
}));
