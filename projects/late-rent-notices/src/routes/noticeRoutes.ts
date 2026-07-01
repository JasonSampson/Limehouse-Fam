import { Router } from "express";
import { z } from "zod";
import { withPmScope } from "../db/withPmScope.js";
import { requireSession, type AuthedRequest } from "./requireSession.js";
import { sendNotice, SendBlockedError } from "../lib/sendNotice.js";
import { sendAsFallback, FallbackCeilingError } from "../lib/sendAsFallback.js";
import { isReauthFresh } from "../auth/requireFreshReauth.js";
import { addBusinessDays } from "../lib/businessCalendar.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace } from "../lib/trace.js";

export const noticeRoutes = Router();
noticeRoutes.use(requireSession);

// Lists drafts/sent notices visible to the signed-in PM only. Every query
// here runs through withPmScope, which sets app.current_pm_id for this
// transaction only — RLS (migration 0016) does the actual filtering, this
// route does not add its own WHERE pm_id = ... clause, by design: the
// database is the enforcement point, not application code.
noticeRoutes.get("/api/notices", async (req: AuthedRequest, res) => {
  const session = req.session!;
  const notices = await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query(
      `SELECT n.id, n.status, n.amount_due_at_draft, n.days_late_at_draft,
              n.drafted_at, n.sent_at, n.delivery_status, n.ledger_verified,
              l.unit_label, p.name AS property_name
       FROM notices n
       JOIN leases l ON l.id = n.lease_id
       JOIN properties p ON p.id = l.property_id
       ORDER BY n.drafted_at DESC`
    );
    return result.rows;
  });
  res.json({ notices });
});

const sendBodySchema = z.object({
  ledgerVerified: z.literal(true, {
    errorMap: () => ({ message: "ledgerVerified must be true — confirm the amount against Buildium first." }),
  }),
});

noticeRoutes.post("/api/notices/:id/send", async (req: AuthedRequest, res) => {
  const session = req.session!;
  const noticeId = Number(req.params.id);
  const parsed = sendBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ledger verification step required before sending.", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await withPmScope(session.pmUserId, async (client) => {
      // RLS already ensures this PM can only touch notices assigned to
      // them (or sent by them as fallback). The explicit assigned_pm_id
      // check below is a second, redundant guard, not the only one.
      const ownership = await client.query<{ assigned_pm_id: number }>(
        "SELECT assigned_pm_id FROM notices WHERE id = $1",
        [noticeId]
      );
      if (ownership.rows.length === 0) {
        throw new SendBlockedError("Notice not found or not visible to you.", "not_visible");
      }
      if (ownership.rows[0].assigned_pm_id !== session.pmUserId) {
        throw new SendBlockedError("This notice is not assigned to you.", "not_assigned");
      }
      return sendNotice(client, {
        noticeId,
        sendingPmId: session.pmUserId,
        sentAsFallback: false,
        ledgerVerifiedByCaller: true,
      });
    });
    res.json(result);
  } catch (err) {
    if (err instanceof SendBlockedError) {
      res.status(409).json({ error: err.message, reason: err.reason });
      return;
    }
    console.error("send notice failed", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Send failed unexpectedly. Check with Jason before retrying." });
  }
});

const voidBodySchema = z.object({ reason: z.string().min(5) });

noticeRoutes.post("/api/notices/:id/void", async (req: AuthedRequest, res) => {
  const session = req.session!;
  const noticeId = Number(req.params.id);
  const parsed = voidBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A reason (5+ characters) is required to void a draft." });
    return;
  }

  await withPmScope(session.pmUserId, async (client) => {
    await client.query(
      "UPDATE notices SET status = 'voided', voided_at = now(), voided_reason = $1 WHERE id = $2 AND assigned_pm_id = $3 AND status = 'draft'",
      [parsed.data.reason, noticeId, session.pmUserId]
    );
    const trace = startTrace();
    await writeAuditLog(client, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      decisionId: `notice-${noticeId}`,
      actorType: "pm",
      actorId: String(session.pmUserId),
      eventType: "notice.voided",
      eventSummary: `PM voided draft notice ${noticeId}: ${parsed.data.reason}`,
      eventData: {},
      contextSnapshot: { noticeId },
      privacyCategory: "Aggregation",
      regulationTags: [],
      riskLevel: "medium",
      legalBasis: "pm_manual_void",
      retentionPolicy: "retain_7_years_post_tenancy",
      trace,
    });
  });
  res.status(204).end();
});

const fallbackSendBodySchema = z.object({ ledgerVerified: z.literal(true) });

// Jason acting as fallback decision-maker — NEVER referred to as
// "override" in code, schema, or UI. Requires: fresh re-auth (checked
// here, not just assumed from session validity), ledger verification, and
// is hard-capped by the DB trigger on fallback_events.
noticeRoutes.post("/api/notices/:id/send-as-fallback", async (req: AuthedRequest, res) => {
  const session = req.session!;
  if (!session.isFallbackDecisionMaker) {
    res.status(403).json({ error: "Your account is not authorized to use the fallback decision-maker action." });
    return;
  }
  if (!isReauthFresh(session)) {
    res.status(401).json({ error: "Fresh re-authentication required for this action. Please sign in again." });
    return;
  }

  const noticeId = Number(req.params.id);
  const parsed = fallbackSendBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Ledger verification step required before sending." });
    return;
  }

  try {
    const result = await withPmScope(session.pmUserId, async (client) => {
      const noticeRow = await client.query<{ assigned_pm_id: number; drafted_at: Date }>(
        "SELECT assigned_pm_id, drafted_at FROM notices WHERE id = $1 AND status = 'draft'",
        [noticeId]
      );
      if (noticeRow.rows.length === 0) {
        throw new SendBlockedError("Notice not found or not in draft status.", "not_found");
      }

      // RLS visibility (migration 0019) lets a fallback decision-maker SEE
      // any draft, but seeing it is not the same as being allowed to send
      // it yet — the assigned PM gets the full 2 business days first. This
      // is the actual enforcement of that rule; without it, RLS visibility
      // alone would let Jason fallback-send the instant a draft is created.
      const deadline = addBusinessDays(noticeRow.rows[0].drafted_at, 2);
      if (new Date() < deadline) {
        throw new SendBlockedError(
          `This draft hasn't reached its 2-business-day deadline yet (${deadline.toISOString()}). ` +
            `The assigned PM still has time to act.`,
          "before_fallback_deadline"
        );
      }

      return sendAsFallback(client, {
        noticeId,
        jasonPmUserId: session.pmUserId,
        assignedPmId: noticeRow.rows[0].assigned_pm_id,
        ledgerVerifiedByCaller: true,
        reauthenticatedAt: new Date(session.authenticatedAt),
      });
    });
    res.json(result);
  } catch (err) {
    if (err instanceof FallbackCeilingError) {
      res.status(429).json({ error: err.message, reason: "fallback_ceiling_exceeded" });
      return;
    }
    if (err instanceof SendBlockedError) {
      res.status(409).json({ error: err.message, reason: err.reason });
      return;
    }
    console.error("fallback send failed", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Fallback send failed unexpectedly. Check with Jason before retrying." });
  }
});
