import { Router } from "express";
import { z } from "zod";
import { withPmScope } from "../db/withPmScope.js";
import { requireSession, type AuthedRequest } from "./requireSession.js";
import { sendNotice, resendBouncedRecipient, SendBlockedError } from "../lib/sendNotice.js";
import { sendAsFallback, FallbackCeilingError } from "../lib/sendAsFallback.js";
import { isReauthFresh } from "../auth/requireFreshReauth.js";
import { addBusinessDays } from "../lib/businessCalendar.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace } from "../lib/trace.js";
import { renderTemplate, formatCurrency, formatDateMMDDYYYY, formatTenantNameList, type MergeFields } from "../templates/renderTemplate.js";
import { formatUnitDisplay, formatMailingAddressLines } from "../lib/unitDisplay.js";
import { getEstimatedCourtCosts, getEstimatedAttorneyFees } from "../lib/config.js";
import { generateNoticePdf, NoticeBodyParseError, ChromeNotFoundError } from "../lib/generateNoticePdf.js";
import {
  getTimeOfDayGreeting,
  formatDueMonthName,
  computePaymentDeadline,
  formatOrdinalDate,
  formatTenantFirstNames,
  renderCoverEmailHtml,
} from "../lib/coverEmailFormatting.js";
import { checkLiveBalanceAndVoidIfStale } from "../lib/staleDraftCheck.js";
import { fetchAndClassifyLeaseCharges, UnclassifiedChargeBlockedError } from "../lib/noticeLineItems.js";
import { calculateLateness } from "../lib/lateness.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { maybeTriggerOnDemandLatenessCheck } from "../lib/onDemandLatenessTrigger.js";

export const noticeRoutes = Router();
noticeRoutes.use(requireSession);

// Lists drafts/sent notices visible to the signed-in PM only. Every query
// here runs through withPmScope, which sets app.current_pm_id for this
// transaction only — RLS (migration 0016) does the actual filtering, this
// route does not add its own WHERE pm_id = ... clause, by design: the
// database is the enforcement point, not application code.
//
// Drafts ONLY (2026-08-14 tab restructure, per Jason: the "Notices" tab
// should show everything that needs a human to act — drafts to review AND
// the stuck no-notice-yet cases from /api/late-no-notice — with the
// separate historical record split out to GET /api/notices/sent below).
noticeRoutes.get("/api/notices", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;

  // Fire-and-forget: a staff member opening this page is, per Jason, usually
  // acting on a bounce email Buildium already sent them — this gives the
  // data a chance to be fresh for that without making every page load wait
  // on a full portfolio check. See onDemandLatenessTrigger.ts for the
  // 15-minute throttle and why this can't just run in-process.
  void maybeTriggerOnDemandLatenessCheck();

  const notices = await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query(
      // Not filtered on p.is_active: a still-draft notice on a property that
      // went inactive mid-review is unusual but not impossible, and should
      // still surface for someone to void/resolve rather than silently
      // vanish — dailyLatenessCheck.ts's own is_active filter is what stops
      // NEW drafts from being created for inactive properties going forward.
      `SELECT n.id, n.status, n.amount_due_at_draft, n.days_late_at_draft,
              n.drafted_at, n.sent_at, n.delivery_status, n.ledger_verified,
              l.unit_label, p.name AS property_name,
              (SELECT count(DISTINCT l2.unit_buildium_id) FROM leases l2 WHERE l2.property_id = l.property_id) > 1 AS multi_unit
       FROM notices n
       JOIN leases l ON l.id = n.lease_id
       JOIN properties p ON p.id = l.property_id
       WHERE n.status = 'draft'
       ORDER BY n.drafted_at DESC`
    );
    // unit_display: "Unit B2" at multi-unit properties, "" at single-family
    // homes (Buildium's obligatory "1" is noise there) — see unitDisplay.ts.
    return result.rows.map((r) => ({ ...r, unit_display: formatUnitDisplay(r.unit_label, r.multi_unit) }));
  });
  res.json({ notices });
}));

// Historical record: everything actually sent — the "Sent Notices" tab.
// Registered here, before GET /api/notices/:id further down, so Express
// matches this literal path first rather than treating "sent" as an :id.
//
// status = 'sent' covers a bounced delivery too: this app tracks a bounce
// via delivery_status = 'bounced' on an otherwise status='sent' row (see the
// frontend's statusBadge, which reads both fields) — the notice really was
// sent, delivery just failed after the fact. notices.status's CHECK
// constraint does technically also allow a literal 'bounced' status value,
// but no code path in this app ever sets it, so it's not queried for here.
noticeRoutes.get("/api/notices/sent", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const notices = await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query(
      `SELECT n.id, n.status, n.amount_due_at_draft, n.days_late_at_draft,
              n.drafted_at, n.sent_at, n.delivery_status, n.ledger_verified,
              l.unit_label, p.name AS property_name,
              (SELECT count(DISTINCT l2.unit_buildium_id) FROM leases l2 WHERE l2.property_id = l.property_id) > 1 AS multi_unit
       FROM notices n
       JOIN leases l ON l.id = n.lease_id
       JOIN properties p ON p.id = l.property_id
       WHERE n.status = 'sent'
       ORDER BY n.sent_at DESC`
    );
    return result.rows.map((r) => ({ ...r, unit_display: formatUnitDisplay(r.unit_label, r.multi_unit) }));
  });
  res.json({ notices });
}));

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
noticeRoutes.get("/api/late-no-notice", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const lateNoNotice = await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query(
      // p.is_active = true: this is an actionable "still needs a notice
      // drafted" queue, not a historical record — an open late_cycles row
      // left over from before a property was marked inactive (sold, taken
      // off management) has nothing left to action here, and showing it
      // would prompt a PM to chase a notice for a property Limehouse no
      // longer manages. dailyLatenessCheck.ts's own is_active filter (see
      // its comment) is what stops NEW rows like this from being created
      // for inactive properties going forward; this filter just also hides
      // any that already exist from before that property was deactivated.
      `SELECT lc.id AS late_cycle_id, lc.lease_id, lc.due_date, lc.opened_at,
              l.unit_label, l.property_id, p.name AS property_name,
              (SELECT count(DISTINCT l2.unit_buildium_id) FROM leases l2 WHERE l2.property_id = l.property_id) > 1 AS multi_unit,
              NOT EXISTS (
                SELECT 1 FROM pm_property_assignments ppa WHERE ppa.property_id = l.property_id
              ) AS needs_pm_assignment
       FROM late_cycles lc
       JOIN leases l ON l.id = lc.lease_id
       JOIN properties p ON p.id = l.property_id
       WHERE lc.closed_at IS NULL
         AND p.is_active = true
         AND NOT EXISTS (
           SELECT 1 FROM notices n WHERE n.late_cycle_id = lc.id
         )
       ORDER BY lc.opened_at ASC`
    );
    return result.rows.map((r) => ({ ...r, unit_display: formatUnitDisplay(r.unit_label, r.multi_unit) }));
  });
  res.json({ lateNoNotice });
}));

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
noticeRoutes.get("/api/notices/:id", asyncHandler(async (req: AuthedRequest, res) => {
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
      voided_reason: string | null;
      letter_template_id: number;
      assigned_pm_id: number;
      drafted_at: Date;
      sent_at: Date | null;
      delivery_status: string;
      ledger_verified: boolean;
      unit_label: string;
      multi_unit: boolean;
      buildium_lease_id: string;
      rent_due_day: number;
      grace_period_days: number;
      property_name: string;
      property_address: string;
      address_line1: string;
      city: string;
      state: string;
      postal_code: string;
      assigned_pm_name: string;
      sent_by_pm_name: string | null;
      viewer_display_name: string;
    }>(
      `SELECT n.id, n.lease_id, n.status, n.amount_due_at_draft, n.days_late_at_draft,
              n.amount_due_at_send, n.days_late_at_send, n.voided_reason, n.letter_template_id,
              n.assigned_pm_id, n.drafted_at, n.sent_at, n.delivery_status, n.ledger_verified,
              l.unit_label, l.buildium_lease_id, l.rent_due_day, l.grace_period_days,
              (SELECT count(DISTINCT l2.unit_buildium_id) FROM leases l2 WHERE l2.property_id = l.property_id) > 1 AS multi_unit,
              p.name AS property_name,
              (p.address_line1 || ', ' || p.city || ', ' || p.state) AS property_address,
              p.address_line1, p.city, p.state, p.postal_code,
              pm.display_name AS assigned_pm_name,
              (SELECT display_name FROM pm_users WHERE id = n.sent_by_pm_id) AS sent_by_pm_name,
              (SELECT display_name FROM pm_users WHERE id = $2) AS viewer_display_name
       FROM notices n
       JOIN leases l ON l.id = n.lease_id
       JOIN properties p ON p.id = l.property_id
       JOIN pm_users pm ON pm.id = n.assigned_pm_id
       WHERE n.id = $1`,
      [noticeId, session.pmUserId]
    );
    if (noticeResult.rows.length === 0) {
      return null;
    }
    const notice = noticeResult.rows[0];

    // Live re-check: a draft notice's numbers are re-verified against
    // Buildium the moment the page loads, not just at the moment of Send —
    // per Jason's report of a notice showing a stale total for a lease that
    // had been paid off that same day, and new same-day charges not
    // appearing either. A sent/voided/bounced notice is never touched here
    // — that stays a permanent historical record of what actually happened.
    // Same field shape as lineItemsResult.rows below (snake_case) so
    // downstream code (sumBucket, the response's lineItems.items map) works
    // unchanged regardless of which source populated `lineItems`.
    let liveLineItems: null | {
      bucket: string;
      gl_account_name: string;
      description: string | null;
      amount: string;
      charge_date: string | null;
    }[] = null;
    let liveDueDate: Date | null = null;
    let liveNoticeDate: Date | null = null;

    if (notice.status === "draft") {
      const staleCheck = await checkLiveBalanceAndVoidIfStale(client, {
        noticeId: notice.id,
        leaseId: notice.lease_id,
        buildiumLeaseId: notice.buildium_lease_id,
        actorType: "system",
        actorId: "notice_review_page_load",
        triggerDescription: "when the notice was opened for review",
        legalBasis: "stale_draft_protection",
        trace: startTrace(),
      });

      if (staleCheck.voided) {
        notice.status = "voided";
        notice.amount_due_at_send = String(staleCheck.liveBalance);
        notice.voided_reason = `Tenant paid down below de minimis threshold when the notice was opened for review.`;
      } else {
        let classifiedBalance;
        try {
          classifiedBalance = await fetchAndClassifyLeaseCharges(notice.buildium_lease_id);
        } catch (err) {
          if (err instanceof UnclassifiedChargeBlockedError) {
            return {
              liveCheckError:
                "Could not safely calculate this notice's live total: some current charges couldn't be classified. Check with Jason before sending.",
            };
          }
          throw err;
        }
        const { dueDate, daysLate } = calculateLateness({
          rentDueDay: notice.rent_due_day,
          gracePeriodDays: notice.grace_period_days,
          balance: staleCheck.liveBalance,
          today: new Date(),
          deMinimisThreshold: staleCheck.deMinimisThreshold,
        });
        notice.amount_due_at_draft = String(staleCheck.liveBalance);
        notice.days_late_at_draft = daysLate;
        liveDueDate = dueDate;
        liveNoticeDate = new Date();
        liveLineItems = classifiedBalance.positiveLines.map((line) => ({
          bucket: line.bucket,
          gl_account_name: line.glAccountName,
          description: line.description,
          amount: String(line.amount),
          charge_date: line.chargeDate,
        }));
      }
    }

    const templateResult = await client.query<{ subject_line: string; body_markdown: string }>(
      "SELECT subject_line, body_markdown FROM letter_templates WHERE id = $1",
      [notice.letter_template_id]
    );
    const template = templateResult.rows[0];

    const recipientsResult = await client.query<{
      id: number;
      recipient_type: string;
      email_address: string;
      full_name: string | null;
      delivery_status: string;
    }>(
      `SELECT nr.id, nr.recipient_type, nr.email_address, lt.full_name, nr.delivery_status
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
    // liveLineItems (set above) replaces the stored snapshot for a draft
    // notice that just passed its live re-check — the live classification is
    // more current than whatever was stored when the notice was drafted,
    // possibly days ago. A sent/voided/bounced notice always keeps its
    // stored, frozen snapshot (liveLineItems stays null in that case).
    const lineItems = liveLineItems ?? lineItemsResult.rows.filter((r) => r.snapshot_stage === lineItemStage);

    // Amount/days-late used for the preview: the "send" snapshot if this
    // notice has already been sent, otherwise the "draft" snapshot (which,
    // for a still-open draft, was just refreshed to the live figure above)
    // — same precedence sendNotice.ts's own columns follow.
    const amountDue = notice.amount_due_at_send ?? notice.amount_due_at_draft;
    const daysLate = notice.days_late_at_send ?? notice.days_late_at_draft;
    const dueDateSource = liveDueDate ?? notice.sent_at ?? notice.drafted_at;
    const noticeDateSource = liveNoticeDate ?? notice.sent_at ?? notice.drafted_at;

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

    // One combined render for every "to" recipient on the lease, matching
    // sendNotice.ts's single-email-to-all-tenants design — tenant_name is a
    // joined list ("Jane Doe and John Doe"), not one render per tenant.
    const previewUnitDisplay = formatUnitDisplay(notice.unit_label, notice.multi_unit);
    const previewMailingAddress = formatMailingAddressLines(
      notice.address_line1,
      notice.city,
      notice.state,
      notice.postal_code,
      previewUnitDisplay
    );
    const mergeFields: MergeFields = {
      tenant_name: formatTenantNameList(toRecipients.map((r) => r.full_name ?? "Tenant")),
      unit_label: previewUnitDisplay,
      amount_due: formatCurrency(Number(amountDue)),
      days_late: String(daysLate),
      due_date: formatDateMMDDYYYY(dueDateSource),
      notice_date: formatDateMMDDYYYY(noticeDateSource),
      property_address: previewMailingAddress.line1,
      property_address_line2: previewMailingAddress.line2,
      // A draft's signature previews as whoever is currently looking at
      // it — accurate to sendNotice.ts's real behavior, since that's
      // exactly who signs it if they click Send right now. Once sent, the
      // signature is fixed to whoever actually sent it (sent_by_pm_name),
      // not whoever happens to be reviewing the history later. Jason's
      // correction, 2026-08-05.
      pm_name: notice.status === "draft" ? notice.viewer_display_name : (notice.sent_by_pm_name ?? notice.assigned_pm_name),
      rent_amount_due: formatCurrency(sumBucket("rent")),
      late_fee_amount_due: formatCurrency(sumBucket("late_fee")),
      misc_amount_due: formatCurrency(sumBucket("other")),
      court_costs_amount: formatCurrency(courtCosts),
      attorney_fees_amount: formatCurrency(attorneyFees),
      total_fees_and_costs_amount: formatCurrency(courtCosts + attorneyFees),
    };
    // escapeForHtml split matches sendNotice.ts exactly: subject is a
    // plain-text header.
    const subject = renderTemplate(template.subject_line, mergeFields, { escapeForHtml: false });
    // The cover-email preview, not the full legal text — must match
    // sendNotice.ts's real behavior exactly (same reasoning as every other
    // field on this page: "the preview matches what Send will actually
    // produce"). noticeDateSource doubles as both the notice_date merge
    // field above and the payment-deadline anchor here, same as
    // sendNotice.ts's own live-send-vs-resend split: a still-open draft's
    // deadline previews as if sent right now, an already-sent notice's
    // deadline stays anchored to when it actually was.
    const bodyHtml = renderCoverEmailHtml({
      greeting: getTimeOfDayGreeting(new Date()),
      tenant_first_names: formatTenantFirstNames(toRecipients.map((r) => r.full_name ?? "Tenant")),
      due_month_name: formatDueMonthName(dueDateSource),
      payment_deadline: formatOrdinalDate(computePaymentDeadline(noticeDateSource)),
      sender_name: mergeFields.pm_name,
    });

    return {
      id: notice.id,
      leaseId: notice.lease_id,
      status: notice.status,
      propertyName: notice.property_name,
      propertyAddress: notice.property_address,
      unitLabel: notice.unit_label,
      unitDisplay: formatUnitDisplay(notice.unit_label, notice.multi_unit),
      assignedPmName: notice.assigned_pm_name,
      amountDueAtDraft: notice.amount_due_at_draft,
      daysLateAtDraft: notice.days_late_at_draft,
      amountDueAtSend: notice.amount_due_at_send,
      daysLateAtSend: notice.days_late_at_send,
      voidedReason: notice.voided_reason,
      draftedAt: notice.drafted_at,
      sentAt: notice.sent_at,
      deliveryStatus: notice.delivery_status,
      ledgerVerified: notice.ledger_verified,
      // "live" (not "draft"/"send") tells the PM these numbers were just
      // re-checked against Buildium this instant, not read from whatever
      // was true when the notice was originally drafted.
      lineItems: {
        snapshotStage: liveLineItems !== null ? "live" : lineItemStage,
        items: lineItems.map((li) => ({
          bucket: li.bucket,
          glAccountName: li.gl_account_name,
          description: li.description,
          amount: li.amount,
          chargeDate: li.charge_date,
        })),
      },
      ccRecipients: ccRecipients.map((r) => ({
        id: r.id,
        emailAddress: r.email_address,
        deliveryStatus: r.delivery_status,
      })),
      // Every "to" recipient on this lease (usually one, more if there are
      // roommates/co-signers) — all of them get the ONE combined email/PDF
      // below, matching sendNotice.ts's single-email-to-all-tenants design.
      toRecipients: toRecipients.map((r) => ({
        id: r.id,
        tenantName: r.full_name ?? "Tenant",
        emailAddress: r.email_address,
        deliveryStatus: r.delivery_status,
      })),
      // This IS what sendNotice.ts would send, not an approximation of it.
      subject,
      bodyHtml,
    };
  });

  if (!detail) {
    res.status(404).json({ error: "Notice not found or not visible to you." });
    return;
  }
  if ("liveCheckError" in detail) {
    res.status(500).json({ error: detail.liveCheckError });
    return;
  }
  res.json({ notice: detail });
}));

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
// A notice can have more than one "to" recipient (roommates/co-signers) —
// this PDF combines all of them into one tenant_name line (matching
// sendNotice.ts's single-email-to-all-tenants design), not one PDF per
// recipient.
noticeRoutes.get("/api/notices/:id/pdf", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const noticeId = Number(req.params.id);
  if (!Number.isInteger(noticeId) || noticeId <= 0) {
    res.status(400).json({ error: "Invalid notice id." });
    return;
  }

  try {
    const built = await withPmScope(session.pmUserId, async (client) => {
      const noticeResult = await client.query<{
        id: number;
        lease_id: number;
        status: string;
        amount_due_at_draft: string;
        days_late_at_draft: number;
        amount_due_at_send: string | null;
        days_late_at_send: number | null;
        letter_template_id: number;
        drafted_at: Date;
        sent_at: Date | null;
        unit_label: string;
        multi_unit: boolean;
        buildium_lease_id: string;
        rent_due_day: number;
        grace_period_days: number;
        property_address: string;
        address_line1: string;
        city: string;
        state: string;
        postal_code: string;
        assigned_pm_name: string;
        sent_by_pm_name: string | null;
        viewer_display_name: string;
      }>(
        `SELECT n.id, n.lease_id, n.status, n.amount_due_at_draft, n.days_late_at_draft,
                n.amount_due_at_send, n.days_late_at_send, n.letter_template_id,
                n.drafted_at, n.sent_at,
                l.unit_label, l.buildium_lease_id, l.rent_due_day, l.grace_period_days,
                (SELECT count(DISTINCT l2.unit_buildium_id) FROM leases l2 WHERE l2.property_id = l.property_id) > 1 AS multi_unit,
                (p.address_line1 || ', ' || p.city || ', ' || p.state) AS property_address,
                p.address_line1, p.city, p.state, p.postal_code,
                pm.display_name AS assigned_pm_name,
                (SELECT display_name FROM pm_users WHERE id = n.sent_by_pm_id) AS sent_by_pm_name,
                (SELECT display_name FROM pm_users WHERE id = $2) AS viewer_display_name
         FROM notices n
         JOIN leases l ON l.id = n.lease_id
         JOIN properties p ON p.id = l.property_id
         JOIN pm_users pm ON pm.id = n.assigned_pm_id
         WHERE n.id = $1`,
        [noticeId, session.pmUserId]
      );
      if (noticeResult.rows.length === 0) {
        return null;
      }
      const notice = noticeResult.rows[0];

      // Same live re-check as the detail route above — the PDF must match
      // what that page just showed, not fall back to a stale snapshot the
      // moment someone clicks "View / Download PDF".
      let liveLineItems: null | { bucket: string; amount: string }[] = null;
      let liveDueDate: Date | null = null;
      let liveNoticeDate: Date | null = null;

      if (notice.status === "draft") {
        const staleCheck = await checkLiveBalanceAndVoidIfStale(client, {
          noticeId: notice.id,
          leaseId: notice.lease_id,
          buildiumLeaseId: notice.buildium_lease_id,
          actorType: "system",
          actorId: "notice_pdf_page_load",
          triggerDescription: "when the notice PDF was opened for review",
          legalBasis: "stale_draft_protection",
          trace: startTrace(),
        });

        if (staleCheck.voided) {
          return { voidedWhileGenerating: true as const };
        }

        const classifiedBalance = await fetchAndClassifyLeaseCharges(notice.buildium_lease_id);
        const { dueDate, daysLate } = calculateLateness({
          rentDueDay: notice.rent_due_day,
          gracePeriodDays: notice.grace_period_days,
          balance: staleCheck.liveBalance,
          today: new Date(),
          deMinimisThreshold: staleCheck.deMinimisThreshold,
        });
        notice.amount_due_at_draft = String(staleCheck.liveBalance);
        notice.days_late_at_draft = daysLate;
        liveDueDate = dueDate;
        liveNoticeDate = new Date();
        liveLineItems = classifiedBalance.positiveLines.map((line) => ({ bucket: line.bucket, amount: String(line.amount) }));
      }

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

      const lineItemsResult = await client.query<{ snapshot_stage: string; bucket: string; amount: string }>(
        `SELECT snapshot_stage, bucket, amount FROM notice_line_items WHERE notice_id = $1`,
        [noticeId]
      );
      const lineItemStage = lineItemsResult.rows.some((r) => r.snapshot_stage === "send") ? "send" : "draft";
      const lineItems = liveLineItems ?? lineItemsResult.rows.filter((r) => r.snapshot_stage === lineItemStage);
      const sumBucket = (bucket: string) =>
        lineItems.filter((li) => li.bucket === bucket).reduce((sum, li) => sum + Number(li.amount), 0);

      const amountDue = notice.amount_due_at_send ?? notice.amount_due_at_draft;
      const daysLate = notice.days_late_at_send ?? notice.days_late_at_draft;
      const dueDateSource = liveDueDate ?? notice.sent_at ?? notice.drafted_at;

      const { amount: courtCosts } = await getEstimatedCourtCosts(client);
      const { amount: attorneyFees } = await getEstimatedAttorneyFees(client);

      const pdfUnitDisplay = formatUnitDisplay(notice.unit_label, notice.multi_unit);
      const pdfMailingAddress = formatMailingAddressLines(
        notice.address_line1,
        notice.city,
        notice.state,
        notice.postal_code,
        pdfUnitDisplay
      );
      const mergeFields: MergeFields = {
        tenant_name: formatTenantNameList(recipientsResult.rows.map((r) => r.full_name ?? "Tenant")),
        unit_label: pdfUnitDisplay,
        amount_due: formatCurrency(Number(amountDue)),
        days_late: String(daysLate),
        due_date: formatDateMMDDYYYY(dueDateSource),
        notice_date: formatDateMMDDYYYY(liveNoticeDate ?? notice.sent_at ?? notice.drafted_at),
        property_address: pdfMailingAddress.line1,
        property_address_line2: pdfMailingAddress.line2,
        // Same rule as the detail route: a draft previews as whoever's
        // currently viewing it (accurate to who'd actually sign it), a
        // sent notice's PDF always shows who actually sent it.
        pm_name: notice.status === "draft" ? notice.viewer_display_name : (notice.sent_by_pm_name ?? notice.assigned_pm_name),
        rent_amount_due: formatCurrency(sumBucket("rent")),
        late_fee_amount_due: formatCurrency(sumBucket("late_fee")),
        misc_amount_due: formatCurrency(sumBucket("other")),
        court_costs_amount: formatCurrency(courtCosts),
        attorney_fees_amount: formatCurrency(attorneyFees),
        total_fees_and_costs_amount: formatCurrency(courtCosts + attorneyFees),
      };

      return {
        mergeFields,
        subjectLine: template.subject_line,
        // Filename identifies by address (plus unit only where one
        // displays) — mirrors sendNotice.ts's attachment naming, since
        // single-family homes no longer display a unit at all.
        filenameBase: `${notice.property_address}${mergeFields.unit_label ? ` ${mergeFields.unit_label}` : ""}`,
      };
    });

    if (!built) {
      res.status(404).json({ error: "Notice not found or not visible to you." });
      return;
    }
    if ("notFoundReason" in built) {
      res.status(404).json({ error: "This notice has no tenant recipients to generate a PDF for." });
      return;
    }
    if ("voidedWhileGenerating" in built) {
      res
        .status(409)
        .json({ error: "This notice was just canceled — the tenant's balance is now paid down below the threshold. Refresh the page to see the update." });
      return;
    }

    const pdf = await generateNoticePdf(built.mergeFields, built.subjectLine);
    const filename = `14-Day-Notice-${built.filenameBase.replace(/[^a-zA-Z0-9]+/g, "-")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    if (err instanceof UnclassifiedChargeBlockedError) {
      console.error("notice PDF generation failed: unclassified live charge", err.message);
      res
        .status(500)
        .json({ error: "Could not safely calculate this notice's live total: some current charges couldn't be classified. Check with Jason before sending." });
      return;
    }
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
}));

const sendBodySchema = z.object({
  ledgerVerified: z.literal(true, {
    errorMap: () => ({ message: "ledgerVerified must be true — confirm the amount against Buildium first." }),
  }),
});

noticeRoutes.post("/api/notices/:id/send", asyncHandler(async (req: AuthedRequest, res) => {
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
      if (Number(ownership.rows[0].assigned_pm_id) !== session.pmUserId) {
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
}));

const voidBodySchema = z.object({ reason: z.string().min(5) });

noticeRoutes.post("/api/notices/:id/void", asyncHandler(async (req: AuthedRequest, res) => {
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
}));

const fallbackSendBodySchema = z.object({ ledgerVerified: z.literal(true) });

// Jason acting as fallback decision-maker — NEVER referred to as
// "override" in code, schema, or UI. Requires: fresh re-auth (checked
// here, not just assumed from session validity), ledger verification, and
// is hard-capped by the DB trigger on fallback_events.
noticeRoutes.post("/api/notices/:id/send-as-fallback", asyncHandler(async (req: AuthedRequest, res) => {
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
}));

// zod's built-in email() check — the same primitive already used for
// GRAPH_SENDER_MAILBOX/JASON_ALERT_EMAIL (src/config/env.ts) and the
// Buildium Email field (src/buildium/client.ts) — not a hand-rolled regex.
const resendBodySchema = z.object({ email: z.string().email() });

// Lets the assigned PM fix a typo'd email address on a recipient whose
// notice bounced, and re-deliver the SAME already-sent notice to just that
// corrected address — see resendBouncedRecipient's doc comment in
// sendNotice.ts for why this doesn't go back through the normal draft->sent
// send() path.
noticeRoutes.post("/api/notices/:id/recipients/:recipientId/resend", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const noticeId = Number(req.params.id);
  const recipientId = Number(req.params.recipientId);
  const parsed = resendBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A valid corrected email address is required.", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await withPmScope(session.pmUserId, async (client) =>
      resendBouncedRecipient(client, {
        noticeId,
        recipientId,
        newEmail: parsed.data.email,
        correctingPmId: session.pmUserId,
      })
    );
    res.json(result);
  } catch (err) {
    if (err instanceof SendBlockedError) {
      res.status(409).json({ error: err.message, reason: err.reason });
      return;
    }
    console.error("resend bounced recipient failed", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "Resend failed unexpectedly. Check with Jason before retrying." });
  }
}));
