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
import { renderTemplate, formatCurrency, type MergeFields } from "../templates/renderTemplate.js";
import { getEstimatedCourtCosts, getEstimatedAttorneyFees } from "../lib/config.js";
import { generateNoticePdf, NoticeBodyParseError, ChromeNotFoundError } from "../lib/generateNoticePdf.js";

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

// "Late but no notice drafted yet" — leases the daily job (see
// dailyLatenessCheck.ts) has already determined are past their grace period
// for the CURRENT due date (an open late_cycles row exists), but which don't
// have a notices row yet for that cycle. This is deliberately read straight
// from late_cycles/notices, not a fresh live Buildium call: the daily job
// already keeps late_cycles current every day, and dailyLatenessCheck.ts
// itself creates BOTH the late_cycles row and the notices row together in
// the same pass (see runDailyLatenessCheck, right after the
// ON CONFLICT... RETURNING id insert) — so a late_cycles row without a
// matching notices row means something stopped that lease short of drafting
// (e.g. no active letter_templates row, no PM assigned to the property, or
// fetchAndClassifyLeaseCharges threw UnclassifiedChargeBlockedError), not a
// timing gap this endpoint needs to re-derive.
//
// "Currently past grace period" = late_cycles.closed_at IS NULL (still an
// open cycle — closed_reason 'paid_in_full'/'paid_below_threshold'/'manual'
// means it's resolved and shouldn't show here even if no notice was ever
// drafted for it, e.g. a tenant who paid before the job got to drafting).
//
// Same withPmScope/RLS pattern as every other route: no WHERE pm_id clause
// here, migration 0016's RLS policies on late_cycles/notices (scoped via
// leases -> pm_property_assignments) are what actually restrict a plain PM
// to their own doors, while admin_assistant/bookkeeping see portfolio-wide
// per their own RLS policies (migrations 0027/0033).
noticeRoutes.get("/api/late-no-notice", async (req: AuthedRequest, res) => {
  const session = req.session!;
  const lateNoNotice = await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query(
      `SELECT lc.id AS late_cycle_id, lc.lease_id, lc.due_date, lc.opened_at,
              l.unit_label, p.name AS property_name
       FROM late_cycles lc
       JOIN leases l ON l.id = lc.lease_id
       JOIN properties p ON p.id = l.property_id
       WHERE lc.closed_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM notices n WHERE n.late_cycle_id = lc.id
         )
       ORDER BY lc.opened_at ASC`
    );
    return result.rows;
  });
  res.json({ lateNoNotice });
});

// Detail/preview for one notice. Same withPmScope + RLS pattern as the list
// route above — no extra WHERE pm_id clause here either, RLS on `notices`
// (migrations 0016/0019) is what actually restricts a plain PM to notices
// assigned to them, while admin_assistant/bookkeeping/a flagged fallback
// decision-maker get the broader visibility already defined there.
//
// This exists so a PM can actually read what a notice says BEFORE clicking
// Review & Send — the list endpoint above only ever returned totals, never
// the tenant name, the itemized breakdown, or the letter text itself. That
// gap defeated the human-review gate this whole module is built around.
//
// Renders the subject/body with the exact same renderTemplate() calls
// sendNotice.ts uses (same escapeForHtml split for subject vs. body too) —
// deliberately NOT a re-implementation, so what a PM previews here is
// guaranteed identical to what would actually be sent. This route is
// strictly read-only: it never writes to notices, never calls Buildium, and
// has no send capability of its own.
//
// Amounts and days-late shown are the FROZEN draft-time snapshot
// (amount_due_at_draft / days_late_at_draft, or amount_due_at_send /
// days_late_at_send once sent) — not a live Buildium re-check. The live
// balance is only re-verified at the moment of send (sendNotice.ts's
// stale-draft protection); a preview showing a different, "more current"
// number than what Send will actually re-verify against would be more
// confusing than useful here.
noticeRoutes.get("/api/notices/:id", async (req: AuthedRequest, res) => {
  const session = req.session!;
  const noticeId = Number(req.params.id);
  if (!Number.isInteger(noticeId) || noticeId <= 0) {
    res.status(400).json({ error: "Invalid notice id." });
    return;
  }

  const detail = await withPmScope(session.pmUserId, async (client) => {
    const noticeResult = await client.query<{
      id: number;
      lease_id: number;
      status: string;
      amount_due_at_draft: string;
      days_late_at_draft: number;
      amount_due_at_send: string | null;
      days_late_at_send: number | null;
      letter_template_id: number;
      assigned_pm_id: number;
      drafted_at: Date;
      sent_at: Date | null;
      delivery_status: string;
      ledger_verified: boolean;
      unit_label: string;
      property_name: string;
      property_address: string;
      assigned_pm_name: string;
    }>(
      `SELECT n.id, n.lease_id, n.status, n.amount_due_at_draft, n.days_late_at_draft,
              n.amount_due_at_send, n.days_late_at_send, n.letter_template_id,
              n.assigned_pm_id, n.drafted_at, n.sent_at, n.delivery_status, n.ledger_verified,
              l.unit_label,
              p.name AS property_name,
              (p.address_line1 || ', ' || p.city || ', ' || p.state) AS property_address,
              pm.display_name AS assigned_pm_name
       FROM notices n
       JOIN leases l ON l.id = n.lease_id
       JOIN properties p ON p.id = l.property_id
       JOIN pm_users pm ON pm.id = n.assigned_pm_id
       WHERE n.id = $1`,
      [noticeId]
    );
    if (noticeResult.rows.length === 0) {
      return null;
    }
    const notice = noticeResult.rows[0];

    const templateResult = await client.query<{ subject_line: string; body_markdown: string }>(
      "SELECT subject_line, body_markdown FROM letter_templates WHERE id = $1",
      [notice.letter_template_id]
    );
    const template = templateResult.rows[0];

    const recipientsResult = await client.query<{
      recipient_type: string;
      email_address: string;
      full_name: string | null;
      delivery_status: string;
    }>(
      `SELECT nr.recipient_type, nr.email_address, lt.full_name, nr.delivery_status
       FROM notice_recipients nr
       LEFT JOIN lease_tenants lt ON lt.id = nr.lease_tenant_id
       WHERE nr.notice_id = $1
       ORDER BY nr.recipient_type, lt.full_name`,
      [noticeId]
    );
    const toRecipients = recipientsResult.rows.filter((r) => r.recipient_type === "to");
    const ccRecipients = recipientsResult.rows.filter((r) => r.recipient_type === "cc");

    // Itemized rent/late-fee/other breakdown, if the classifier has ever
    // populated it for this notice (see migration 0038/0039 — nothing writes
    // to this table yet as of this endpoint, so an empty array here is
    // expected today, not a bug). 'send' snapshot wins over 'draft' once it
    // exists, mirroring amount_due_at_draft/_at_send.
    const lineItemsResult = await client.query<{
      snapshot_stage: string;
      bucket: string;
      gl_account_name: string;
      description: string | null;
      amount: string;
      charge_date: string | null;
    }>(
      `SELECT snapshot_stage, bucket, gl_account_name, description, amount, charge_date
       FROM notice_line_items
       WHERE notice_id = $1
       ORDER BY snapshot_stage DESC, bucket, charge_date`,
      [noticeId]
    );
    const lineItemStage = lineItemsResult.rows.some((r) => r.snapshot_stage === "send") ? "send" : "draft";
    const lineItems = lineItemsResult.rows.filter((r) => r.snapshot_stage === lineItemStage);

    // Amount/days-late used for the preview: the "send" snapshot if this
    // notice has already been sent, otherwise the "draft" snapshot — same
    // precedence sendNotice.ts's own columns follow.
    const amountDue = notice.amount_due_at_send ?? notice.amount_due_at_draft;
    const daysLate = notice.days_late_at_send ?? notice.days_late_at_draft;
    const dueDateSource = notice.sent_at ?? notice.drafted_at;

    // Bucket sums for the itemized merge fields — same buckets
    // glClassification.ts writes to notice_line_items with ('rent' |
    // 'late_fee' | 'other'), summed over whichever snapshot stage we're
    // previewing (see lineItemStage above). Empty today until a notice has
    // actually gone through the classifier; formatCurrency(0) renders as
    // "$0.00", which is the correct "not yet classified" preview state,
    // not a false claim about what's owed.
    const sumBucket = (bucket: string) =>
      lineItems
        .filter((li) => li.bucket === bucket)
        .reduce((sum, li) => sum + Number(li.amount), 0);

    // Fixed, same-for-every-notice ESTIMATES (migrations 0040/0041) — read
    // once per preview render, not per recipient, since they don't vary by
    // tenant. Same currently-active config version sendNotice.ts itself
    // would read if this notice were sent right now, so the preview matches
    // what Send will actually produce (same principle as the rest of this
    // route's doc comment above).
    const { amount: courtCosts } = await getEstimatedCourtCosts(client);
    const { amount: attorneyFees } = await getEstimatedAttorneyFees(client);

    // Rendered once per "to" recipient, same as sendNotice.ts — roommates
    // each see their own name in the body, even though CC'd staff don't get
    // their own copy of the merge fields.
    const renderedRecipients = toRecipients.map((toRecipient) => {
      const mergeFields: MergeFields = {
        tenant_name: toRecipient.full_name ?? "Tenant",
        unit_label: notice.unit_label,
        amount_due: formatCurrency(Number(amountDue)),
        days_late: String(daysLate),
        due_date: dueDateSource.toISOString().slice(0, 10),
        notice_date: (notice.sent_at ?? notice.drafted_at).toISOString().slice(0, 10),
        property_address: notice.property_address,
        pm_name: notice.assigned_pm_name,
        rent_amount_due: formatCurrency(sumBucket("rent")),
        late_fee_amount_due: formatCurrency(sumBucket("late_fee")),
        misc_amount_due: formatCurrency(sumBucket("other")),
        court_costs_amount: formatCurrency(courtCosts),
        attorney_fees_amount: formatCurrency(attorneyFees),
        total_fees_and_costs_amount: formatCurrency(courtCosts + attorneyFees),
      };

      return {
        tenantName: mergeFields.tenant_name,
        emailAddress: toRecipient.email_address,
        deliveryStatus: toRecipient.delivery_status,
        // escapeForHtml split matches sendNotice.ts exactly: subject is a
        // plain-text header, body becomes bodyHtml.
        subject: renderTemplate(template.subject_line, mergeFields, { escapeForHtml: false }),
        bodyHtml: renderTemplate(template.body_markdown, mergeFields).replace(/\n/g, "<br>"),
      };
    });

    return {
      id: notice.id,
      leaseId: notice.lease_id,
      status: notice.status,
      propertyName: notice.property_name,
      propertyAddress: notice.property_address,
      unitLabel: notice.unit_label,
      assignedPmName: notice.assigned_pm_name,
      amountDueAtDraft: notice.amount_due_at_draft,
      daysLateAtDraft: notice.days_late_at_draft,
      amountDueAtSend: notice.amount_due_at_send,
      daysLateAtSend: notice.days_late_at_send,
      draftedAt: notice.drafted_at,
      sentAt: notice.sent_at,
      deliveryStatus: notice.delivery_status,
      ledgerVerified: notice.ledger_verified,
      lineItems: {
        snapshotStage: lineItemStage,
        items: lineItems.map((li) => ({
          bucket: li.bucket,
          glAccountName: li.gl_account_name,
          description: li.description,
          amount: li.amount,
          chargeDate: li.charge_date,
        })),
      },
      ccRecipients: ccRecipients.map((r) => ({ emailAddress: r.email_address, deliveryStatus: r.delivery_status })),
      // One rendered subject/body per "to" recipient (usually one, more if
      // there are roommates) — this IS what sendNotice.ts would send, not
      // an approximation of it.
      recipients: renderedRecipients,
    };
  });

  if (!detail) {
    res.status(404).json({ error: "Notice not found or not visible to you." });
    return;
  }
  res.json({ notice: detail });
});

// Print-formatted PDF preview/download for one notice — lets a PM see and
// print the EXACT document that would be attached at send time (matching
// the attorney's original paper form layout) before clicking Review & Send,
// same "review before you send a legal document" principle the detail
// route above documents. Deliberately re-queries the DB fresh (same pattern
// as the send route below, not the detail route's closures) rather than
// sharing state across routes.
//
// Same withPmScope/RLS visibility as every other route here — a PM can only
// generate a PDF for a notice actually visible to them.
//
// A notice can have more than one "to" recipient (roommates/co-signers),
// each seeing their own name in the body — ?recipient=<email> selects which
// one to render; omitted defaults to the first "to" recipient, matching the
// order the detail route's `recipients` array already returns.
noticeRoutes.get("/api/notices/:id/pdf", async (req: AuthedRequest, res) => {
  const session = req.session!;
  const noticeId = Number(req.params.id);
  if (!Number.isInteger(noticeId) || noticeId <= 0) {
    res.status(400).json({ error: "Invalid notice id." });
    return;
  }
  const requestedRecipientEmail =
    typeof req.query.recipient === "string" ? req.query.recipient : undefined;

  try {
    const built = await withPmScope(session.pmUserId, async (client) => {
      const noticeResult = await client.query<{
        id: number;
        amount_due_at_draft: string;
        days_late_at_draft: number;
        amount_due_at_send: string | null;
        days_late_at_send: number | null;
        letter_template_id: number;
        drafted_at: Date;
        sent_at: Date | null;
        unit_label: string;
        property_address: string;
        assigned_pm_name: string;
      }>(
        `SELECT n.id, n.amount_due_at_draft, n.days_late_at_draft,
                n.amount_due_at_send, n.days_late_at_send, n.letter_template_id,
                n.drafted_at, n.sent_at,
                l.unit_label,
                (p.address_line1 || ', ' || p.city || ', ' || p.state) AS property_address,
                pm.display_name AS assigned_pm_name
         FROM notices n
         JOIN leases l ON l.id = n.lease_id
         JOIN properties p ON p.id = l.property_id
         JOIN pm_users pm ON pm.id = n.assigned_pm_id
         WHERE n.id = $1`,
        [noticeId]
      );
      if (noticeResult.rows.length === 0) {
        return null;
      }
      const notice = noticeResult.rows[0];

      const templateResult = await client.query<{ subject_line: string; body_markdown: string }>(
        "SELECT subject_line, body_markdown FROM letter_templates WHERE id = $1",
        [notice.letter_template_id]
      );
      const template = templateResult.rows[0];

      const recipientsResult = await client.query<{ email_address: string; full_name: string | null }>(
        `SELECT nr.email_address, lt.full_name
         FROM notice_recipients nr
         LEFT JOIN lease_tenants lt ON lt.id = nr.lease_tenant_id
         WHERE nr.notice_id = $1 AND nr.recipient_type = 'to'
         ORDER BY lt.full_name`,
        [noticeId]
      );
      if (recipientsResult.rows.length === 0) {
        return { notFoundReason: "no_to_recipients" as const };
      }
      const toRecipient = requestedRecipientEmail
        ? recipientsResult.rows.find((r) => r.email_address === requestedRecipientEmail)
        : recipientsResult.rows[0];
      if (!toRecipient) {
        return { notFoundReason: "recipient_not_found" as const };
      }

      const lineItemsResult = await client.query<{ snapshot_stage: string; bucket: string; amount: string }>(
        `SELECT snapshot_stage, bucket, amount FROM notice_line_items WHERE notice_id = $1`,
        [noticeId]
      );
      const lineItemStage = lineItemsResult.rows.some((r) => r.snapshot_stage === "send") ? "send" : "draft";
      const lineItems = lineItemsResult.rows.filter((r) => r.snapshot_stage === lineItemStage);
      const sumBucket = (bucket: string) =>
        lineItems.filter((li) => li.bucket === bucket).reduce((sum, li) => sum + Number(li.amount), 0);

      const amountDue = notice.amount_due_at_send ?? notice.amount_due_at_draft;
      const daysLate = notice.days_late_at_send ?? notice.days_late_at_draft;
      const dueDateSource = notice.sent_at ?? notice.drafted_at;

      const { amount: courtCosts } = await getEstimatedCourtCosts(client);
      const { amount: attorneyFees } = await getEstimatedAttorneyFees(client);

      const mergeFields: MergeFields = {
        tenant_name: toRecipient.full_name ?? "Tenant",
        unit_label: notice.unit_label,
        amount_due: formatCurrency(Number(amountDue)),
        days_late: String(daysLate),
        due_date: dueDateSource.toISOString().slice(0, 10),
        notice_date: (notice.sent_at ?? notice.drafted_at).toISOString().slice(0, 10),
        property_address: notice.property_address,
        pm_name: notice.assigned_pm_name,
        rent_amount_due: formatCurrency(sumBucket("rent")),
        late_fee_amount_due: formatCurrency(sumBucket("late_fee")),
        misc_amount_due: formatCurrency(sumBucket("other")),
        court_costs_amount: formatCurrency(courtCosts),
        attorney_fees_amount: formatCurrency(attorneyFees),
        total_fees_and_costs_amount: formatCurrency(courtCosts + attorneyFees),
      };

      return { mergeFields, subjectLine: template.subject_line, unitLabel: notice.unit_label };
    });

    if (!built) {
      res.status(404).json({ error: "Notice not found or not visible to you." });
      return;
    }
    if ("notFoundReason" in built) {
      res.status(404).json({ error: "No matching recipient found for this notice." });
      return;
    }

    const pdf = await generateNoticePdf(built.mergeFields, built.subjectLine);
    const filename = `14-Day-Notice-${built.unitLabel.replace(/[^a-zA-Z0-9]+/g, "-")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    if (err instanceof NoticeBodyParseError) {
      console.error("notice PDF generation failed: body parse error", err.message);
      res.status(500).json({ error: "Could not generate the PDF: the notice text didn't match the expected layout. Check with Jason before sending." });
      return;
    }
    if (err instanceof ChromeNotFoundError) {
      console.error("notice PDF generation failed: Chrome not found", err.message);
      res.status(500).json({ error: "Could not generate the PDF: no Chrome browser is available on this server. Check with Scotty." });
      return;
    }
    console.error("notice PDF generation failed", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "PDF generation failed unexpectedly." });
  }
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
