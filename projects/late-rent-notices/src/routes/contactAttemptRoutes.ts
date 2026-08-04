import { Router } from "express";
import { z } from "zod";
import { withPmScope } from "../db/withPmScope.js";
import { requireSession, type AuthedRequest } from "./requireSession.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace } from "../lib/trace.js";
import { syncToLeadSimple } from "../integrations/leadSimpleSync.js";
import { logError } from "../lib/appLogger.js";

export const contactAttemptRoutes = Router();
contactAttemptRoutes.use(requireSession);

// Read: any signed-in PM/admin_assistant can list contact attempts visible
// to them — RLS (migration 0027) is the actual scope gate: admin_assistant
// sees every lease company-wide, a regular PM only sees leases on their
// assigned doors. No separate ownership check needed here, same pattern as
// leaseRoutes.ts.
contactAttemptRoutes.get("/api/contact-attempts", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const leaseId = req.query.leaseId ? Number(req.query.leaseId) : undefined;

  const contactAttempts = await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query(
      `SELECT ca.id, ca.lease_id, ca.contact_method, ca.contact_note, ca.outcome,
              ca.promised_pay_date, ca.occurred_at, ca.logged_by_pm_id
       FROM contact_attempts ca
       WHERE ($1::BIGINT IS NULL OR ca.lease_id = $1)
       ORDER BY ca.occurred_at DESC`,
      [leaseId ?? null]
    );
    return result.rows;
  });

  res.json({ contactAttempts });
}));

const createContactAttemptSchema = z.object({
  leaseId: z.number().int().positive(),
  contactMethod: z.enum(["phone", "email", "text"]),
  contactNote: z.string().optional(),
  outcome: z.enum(["reached_tenant", "left_voicemail_no_answer", "promised_to_pay", "disputed_charge"]),
  promisedPayDate: z.string().optional(), // YYYY-MM-DD, required when outcome is promised_to_pay
  occurredAt: z.string().datetime().optional(), // defaults to now() if omitted
});

// Insert is restricted to admin_assistant at the DATABASE level (migration
// 0027's insert_contact_attempts_admin_assistant RLS policy) — this route
// intentionally does not duplicate that check itself, so RLS stays the one
// real source of truth and this route can't drift out of sync with it. A
// non-admin_assistant PM's INSERT will simply be rejected by Postgres and
// surfaces here as a query error.
contactAttemptRoutes.post("/api/contact-attempts", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const parsed = createContactAttemptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid contact attempt.", details: parsed.error.flatten() });
    return;
  }
  if (parsed.data.outcome === "promised_to_pay" && !parsed.data.promisedPayDate) {
    res.status(400).json({ error: "promisedPayDate is required when outcome is promised_to_pay." });
    return;
  }

  let inserted: { id: number; occurred_at: Date } | null;
  try {
    inserted = await withPmScope(session.pmUserId, async (client) => {
      const result = await client.query<{ id: number; occurred_at: Date }>(
        `INSERT INTO contact_attempts
           (lease_id, logged_by_pm_id, contact_method, contact_note, outcome, promised_pay_date, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
         RETURNING id, occurred_at`,
        [
          parsed.data.leaseId,
          session.pmUserId,
          parsed.data.contactMethod,
          parsed.data.contactNote ?? null,
          parsed.data.outcome,
          parsed.data.promisedPayDate ?? null,
          parsed.data.occurredAt ?? null,
        ]
      );
      const row = result.rows[0];

      const trace = startTrace();
      await writeAuditLog(client, {
        companyId: "limehouse-pm",
        instanceId: "late-rent-notices",
        actorType: "admin_assistant",
        actorId: String(session.pmUserId),
        eventType: "contact_attempt.logged",
        eventSummary: `Contact attempt logged for lease ${parsed.data.leaseId} (method: ${parsed.data.contactMethod}, outcome: ${parsed.data.outcome}).`,
        eventData: { contactMethod: parsed.data.contactMethod, outcome: parsed.data.outcome },
        contextSnapshot: { leaseId: parsed.data.leaseId, contactAttemptId: row.id },
        privacyCategory: "Aggregation",
        regulationTags: [],
        riskLevel: "low",
        legalBasis: "manual_tenant_contact_log",
        retentionPolicy: "retain_7_years_post_tenancy",
        trace,
      });

      return row;
    });
  } catch (err) {
    // RLS denial (non-admin_assistant PM) surfaces as a Postgres permission
    // error here — treat it as a 403, not a 500.
    res.status(403).json({ error: "Not permitted to log contact attempts." });
    return;
  }

  // LeadSimple mirror is a best-effort side effect, isolated behind its own
  // function — see leadSimpleSync.ts. It must never fail or block the
  // response; the contact_attempts row is already committed and is the
  // source of truth regardless of whether this succeeds.
  try {
    await syncToLeadSimple({
      contactAttemptId: inserted.id,
      leaseId: parsed.data.leaseId,
      contactMethod: parsed.data.contactMethod,
      outcome: parsed.data.outcome,
      occurredAt: inserted.occurred_at,
    });
  } catch (err) {
    logError("LeadSimple sync failed for contact attempt", { leaseId: parsed.data.leaseId });
  }

  res.status(201).json(inserted);
}));
