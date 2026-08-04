import type { PoolClient } from "pg";
import { loadEnv } from "../config/env.js";
import { getEstimatedCourtCosts, getEstimatedAttorneyFees } from "./config.js";
import { calculateLateness } from "./lateness.js";
import {
  fetchAndClassifyLeaseCharges,
  insertNoticeLineItems,
  UnclassifiedChargeBlockedError,
} from "./noticeLineItems.js";
import { renderTemplate, formatCurrency, formatDateMMDDYYYY, type MergeFields } from "../templates/renderTemplate.js";
import { formatUnitDisplay, formatMailingAddressLines } from "./unitDisplay.js";
import { sendGraphMail, sendPmNotificationEmail } from "../email/graphMailer.js";
import { generateNoticePdf } from "./generateNoticePdf.js";
import { renderNoticeBodyToHtml } from "./noticeBodyFormatting.js";
import { checkLiveBalanceAndVoidIfStale } from "./staleDraftCheck.js";
import { mirrorNoticeToLeadSimple } from "../integrations/leadSimpleClient.js";
import { writeAuditLog } from "./auditLog.js";
import { startTrace } from "./trace.js";
import { logInfo, logWarn } from "./appLogger.js";

// Joins tenant names into one readable list for a single combined notice
// email ("Jane Doe", "Jane Doe and John Doe", "Jane Doe, John Doe, and Mary
// Doe"). Jason confirmed one combined email to every tenant on the lease is
// fine, in place of a separate email per tenant.
export function formatTenantNameList(names: string[]): string {
  if (names.length === 0) return "Tenant";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export class SendBlockedError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = "SendBlockedError";
  }
}

interface SendNoticeParams {
  noticeId: number;
  // The PM clicking Send. If this is a fallback send, callers must have
  // already inserted the fallback_events row (which enforces the ceiling)
  // in the SAME transaction as this call — see sendAsFallback.ts.
  sendingPmId: number;
  sentAsFallback: boolean;
  // Required: the PM (or Jason, for fallback) must have visually confirmed
  // the displayed dollar amount against Buildium before this is callable.
  // This is Mason's mandatory ledger-verification step — enforced again
  // at the DB level by the trg_enforce_ledger_verified trigger.
  ledgerVerifiedByCaller: boolean;
}

interface NoticeRow {
  id: number;
  lease_id: number;
  status: string;
  letter_template_id: number;
  assigned_pm_id: number;
}

// The single most consequential action in this system. Order of operations
// matters:
//   1. Re-check the LIVE Buildium balance (stale-draft protection) — if the
//      tenant has paid down below threshold since the draft was made, void
//      the draft and block the send. Never send a notice demanding money
//      that's no longer owed.
//   1b. Re-fetch and re-classify the LIVE itemized charge breakdown (same
//      stale-draft principle as the balance check, applied per-line — see
//      migration 0038/glClassification.ts). If any charge line can't be
//      safely classified, block the send outright (SendBlockedError) rather
//      than send a legal notice with a dollar amount that silently
//      disappeared or got guessed into the wrong bucket.
//   2. Require the ledger-verification step to have actually happened.
//   3. In shadow mode, stop here: log what WOULD have been sent, but do
//      not actually call Graph sendMail. This is the default and required
//      starting state — there is deliberately no flag to skip it.
//   4. Send via Graph, record per-recipient delivery status, write the
//      audit log entry.
export async function sendNotice(client: PoolClient, params: SendNoticeParams): Promise<{ sent: boolean; voided: boolean }> {
  const env = loadEnv();
  const trace = startTrace();

  if (!params.ledgerVerifiedByCaller) {
    throw new SendBlockedError(
      "Cannot send: ledger-verification step was not completed by the sender.",
      "ledger_verification_missing"
    );
  }

  const noticeResult = await client.query<NoticeRow>(
    "SELECT id, lease_id, status, letter_template_id, assigned_pm_id FROM notices WHERE id = $1 FOR UPDATE",
    [params.noticeId]
  );
  if (noticeResult.rows.length === 0) {
    throw new SendBlockedError(`Notice ${params.noticeId} not found`, "not_found");
  }
  const notice = noticeResult.rows[0];
  if (notice.status !== "draft") {
    throw new SendBlockedError(
      `Notice ${params.noticeId} is not in draft status (status=${notice.status}); cannot send.`,
      "not_draft"
    );
  }

  const leaseResult = await client.query<{
    buildium_lease_id: string;
    unit_label: string;
    multi_unit: boolean;
    property_address: string;
    address_line1: string;
    city: string;
    state: string;
    postal_code: string;
    rent_due_day: number;
    grace_period_days: number;
    assigned_pm_name: string;
    assigned_pm_email: string;
  }>(
    // Not filtered on p.is_active: notice.lease_id already points at a
    // notice drafted BEFORE this send action — the property being active
    // or not today has no bearing on rendering/sending a document that
    // already exists (properties.is_active only gates whether new notices
    // get drafted in the first place, see dailyLatenessCheck.ts).
    `SELECT l.buildium_lease_id, l.unit_label, l.rent_due_day, l.grace_period_days,
            (SELECT count(DISTINCT l2.unit_buildium_id) FROM leases l2 WHERE l2.property_id = l.property_id) > 1 AS multi_unit,
            (p.address_line1 || ', ' || p.city || ', ' || p.state) AS property_address,
            p.address_line1, p.city, p.state, p.postal_code,
            pm.display_name AS assigned_pm_name, pm.email AS assigned_pm_email
     FROM leases l
     JOIN properties p ON p.id = l.property_id
     JOIN pm_users pm ON pm.id = $2
     WHERE l.id = $1`,
    [notice.lease_id, notice.assigned_pm_id]
  );
  const lease = leaseResult.rows[0];
  const unitDisplay = formatUnitDisplay(lease.unit_label, lease.multi_unit);
  const mailingAddress = formatMailingAddressLines(lease.address_line1, lease.city, lease.state, lease.postal_code, unitDisplay);

  // Step 1: stale-draft protection. Live balance, not the cached draft
  // figure. Shared with noticeRoutes.ts's review-page route (see
  // staleDraftCheck.ts) — same check, run at a different moment.
  const staleCheck = await checkLiveBalanceAndVoidIfStale(client, {
    noticeId: params.noticeId,
    leaseId: notice.lease_id,
    buildiumLeaseId: lease.buildium_lease_id,
    actorType: params.sentAsFallback ? "fallback_decision_maker" : "pm",
    actorId: String(params.sendingPmId),
    triggerDescription: "before send (stale-draft check)",
    legalBasis: "stale_draft_protection",
    trace,
  });

  if (staleCheck.voided) {
    return { sent: false, voided: true };
  }

  const liveBalance = { balance: staleCheck.liveBalance };
  const deMinimisThreshold = staleCheck.deMinimisThreshold;

  // Step 1b: live itemized charge breakdown, re-fetched and re-classified
  // at send time (same "never trust the draft-time snapshot" principle as
  // the balance recheck above). An unclassifiable charge line blocks the
  // send the same way ledger-verification-missing or a not-found notice
  // does — never let a dollar amount silently disappear from, or get
  // guessed into the wrong bucket of, a legal notice.
  let classifiedBalance;
  try {
    classifiedBalance = await fetchAndClassifyLeaseCharges(lease.buildium_lease_id);
  } catch (err) {
    if (err instanceof UnclassifiedChargeBlockedError) {
      throw new SendBlockedError(
        `Cannot send notice ${params.noticeId}: ${err.message}`,
        "unclassified_charge_line"
      );
    }
    throw err;
  }
  // bucketTotals is fully netted (includes any credit/negative GL balance —
  // see noticeLineItems.ts's big comment) so rent+late_fee+other always
  // equals the true live balance exactly, even in the rare case where one
  // GL account carries a credit while the lease still owes overall.
  // positiveLines is the (always amount > 0) detail stored for the audit
  // trail / notice support detail.
  const bucketSums = classifiedBalance.bucketTotals;

  await insertNoticeLineItems(client, params.noticeId, "send", classifiedBalance.positiveLines);

  if (env.SHADOW_MODE) {
    // Shadow mode: the daily job and drafting run for real, but Send is a
    // no-op that logs what WOULD have been sent. This is the default,
    // required starting state — there is no config flag to bypass this
    // from inside the send path itself; SHADOW_MODE must be flipped at the
    // environment level, a separate, deliberate decision.
    await writeAuditLog(client, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      decisionId: `notice-${params.noticeId}`,
      actorType: params.sentAsFallback ? "fallback_decision_maker" : "pm",
      actorId: String(params.sendingPmId),
      eventType: "notice.shadow_send",
      eventSummary: `SHADOW MODE: notice ${params.noticeId} would have been sent now. No email actually sent.`,
      eventData: { shadowMode: true, liveBalance: liveBalance.balance },
      contextSnapshot: { noticeId: params.noticeId, leaseId: notice.lease_id },
      privacyCategory: "Aggregation",
      regulationTags: ["VRLTA"],
      riskLevel: "high",
      legalBasis: "shadow_mode_no_op",
      retentionPolicy: "retain_7_years_post_tenancy",
      trace,
    });
    logInfo("shadow mode: notice send suppressed", { noticeId: params.noticeId, traceId: trace.trace_id });
    return { sent: false, voided: false };
  }

  // Step 2 (live mode): render the letter, send via Graph, record results.
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
  }>(
    `SELECT nr.id, nr.recipient_type, nr.email_address, lt.full_name
     FROM notice_recipients nr
     LEFT JOIN lease_tenants lt ON lt.id = nr.lease_tenant_id
     WHERE nr.notice_id = $1`,
    [params.noticeId]
  );

  const toRecipients = recipientsResult.rows.filter((r) => r.recipient_type === "to");
  const ccRecipients = recipientsResult.rows.filter((r) => r.recipient_type === "cc");

  // Each tenant gets their own personalized name in the body, but Graph
  // sendMail doesn't support per-recipient body templating in one call —
  // send one email per "to" recipient (each cc'd to the PM) so roommates
  // each see their own name, while still satisfying "all tenants receive
  // the notice."
  // Real days-late/due-date, computed from the lease's actual due day and
  // grace period — NOT from liveBalance.asOf, which is just the timestamp
  // Buildium reported the balance at (effectively "now"). Using asOf here
  // would make every notice read as "0 days late" with today's date as the
  // due date, which is wrong on its face for a legal notice.
  const { dueDate, daysLate } = calculateLateness({
    rentDueDay: lease.rent_due_day,
    gracePeriodDays: lease.grace_period_days,
    balance: liveBalance.balance,
    today: new Date(),
    deMinimisThreshold,
  });

  // Fixed, same-for-every-notice ESTIMATES (migrations 0040/0041) — read
  // fresh at send time same as every other config value here, so a
  // mid-cycle change to Jason's SOP figures (a new config version activated
  // between draft and send) is reflected in what actually gets sent, not
  // whatever was active back when the draft was made.
  const { amount: courtCosts } = await getEstimatedCourtCosts(client);
  const { amount: attorneyFees } = await getEstimatedAttorneyFees(client);

  // One combined email to every "to" recipient on the lease, rather than a
  // separate email per tenant — Jason confirmed this is fine, and Graph
  // sendMail already supports multiple "to" addresses on one message.
  // tenant_name becomes a joined list ("Jane Doe and John Doe") so
  // roommates/co-signers all see themselves named, not just one tenant.
  const mergeFields: MergeFields = {
    tenant_name: formatTenantNameList(toRecipients.map((r) => r.full_name ?? "Tenant")),
    // "Unit B2" at a multi-unit property, blank at a single-family house —
    // see unitDisplay.ts. Folded into property_address (line 1) below, not
    // rendered as its own header line.
    unit_label: unitDisplay,
    amount_due: formatCurrency(liveBalance.balance),
    days_late: String(daysLate),
    due_date: formatDateMMDDYYYY(dueDate),
    notice_date: formatDateMMDDYYYY(new Date()),
    // Standard two-line mailing address — see formatMailingAddressLines.
    property_address: mailingAddress.line1,
    property_address_line2: mailingAddress.line2,
    pm_name: lease.assigned_pm_name,
    // Real computed itemized amounts (migration 0038 / notice_line_items),
    // classified fresh above at send time.
    rent_amount_due: formatCurrency(bucketSums.rent),
    late_fee_amount_due: formatCurrency(bucketSums.late_fee),
    misc_amount_due: formatCurrency(bucketSums.other),
    // Fixed estimates (migrations 0040/0041), same on every notice — NOT
    // derived from bucketSums/notice_line_items. total is a plain sum,
    // computed here, not stored/re-derived anywhere else.
    court_costs_amount: formatCurrency(courtCosts),
    attorney_fees_amount: formatCurrency(attorneyFees),
    total_fees_and_costs_amount: formatCurrency(courtCosts + attorneyFees),
  };

  // Subject is a plain-text email header, not HTML — must not be escaped
  // (see renderTemplate's escapeForHtml doc comment), while the body
  // becomes bodyHtml and needs the default HTML-escaping.
  const subject = renderTemplate(template.subject_line, mergeFields, { escapeForHtml: false });
  // escapeForHtml: false — renderNoticeBodyToHtml does its own escaping
  // pass (same reasoning as generateNoticePdf.ts's buildNoticePrintHtml:
  // using the default here would escape merge field values twice). This
  // also reflows INITIAL_BODY_MARKDOWN's source-file hard-wrapped lines
  // into real paragraphs instead of turning every line break into a
  // visible <br>, which used to split sentences mid-way through.
  const renderedBody = renderTemplate(template.body_markdown, mergeFields, { escapeForHtml: false });
  const bodyHtml = renderNoticeBodyToHtml(renderedBody);

  // Print-formatted PDF copy of the same notice, matching the attorney's
  // original paper form layout, attached so the tenant (and Jason, if this
  // ends up in court) has something that can be printed as a physical
  // exhibit — see generateNoticePdf.ts. Built from the SAME mergeFields as
  // the email body above; the wording is never re-typed, only reformatted.
  const noticePdf = await generateNoticePdf(mergeFields, template.subject_line);
  // Filename identifies by address (plus unit only where one displays) —
  // it can't lean on the unit label alone anymore, since single-family
  // homes now display no unit at all.
  const pdfFilename = `14-Day-Notice-${`${lease.property_address}${unitDisplay ? ` ${unitDisplay}` : ""}`.replace(/[^a-zA-Z0-9]+/g, "-")}.pdf`;

  // The notice goes out FROM the staff member who clicked Send — their
  // identity (including this email) arrived via their LimeHQ login and is
  // the same pm_users row the session resolved. Jason's decision: a tenant
  // sees the actual person handling their notice, not a shared mailbox.
  // Their limehousepm.com address must match their Microsoft 365 mailbox
  // (LimeHQ Staff & Permissions is the source of truth for that email).
  const senderResult = await client.query<{ display_name: string; email: string }>(
    "SELECT display_name, email FROM pm_users WHERE id = $1",
    [params.sendingPmId]
  );
  const sender = senderResult.rows[0];

  const result = await sendGraphMail({
    subject,
    bodyHtml,
    toRecipients: toRecipients.map((r) => ({ email: r.email_address })),
    ccRecipients: ccRecipients.map((r) => ({ email: r.email_address })),
    senderMailbox: sender?.email,
    attachments: [
      {
        name: pdfFilename,
        contentType: "application/pdf",
        contentBytes: noticePdf,
      },
    ],
  });

  await client.query(
    "UPDATE notice_recipients SET delivery_status = $1, bounced_at = $2 WHERE notice_id = $3 AND recipient_type = 'to'",
    [result.success ? "sent" : "bounced", result.success ? null : new Date(), params.noticeId]
  );

  const allSucceeded = result.success;
  const finalDeliveryStatus = allSucceeded ? "sent" : "bounced";

  await client.query(
    `UPDATE notices SET
       status = 'sent', sent_at = now(), sent_by_pm_id = $1, sent_as_fallback = $2,
       ledger_verified = true, amount_due_at_send = $3,
       delivery_status = $4
     WHERE id = $5`,
    [params.sendingPmId, params.sentAsFallback, liveBalance.balance, finalDeliveryStatus, params.noticeId]
  );

  if (!allSucceeded) {
    await client.query("UPDATE notices SET pm_bounce_notified_at = now() WHERE id = $1", [params.noticeId]);
    // Delivery-failure visibility (Asimov + Mason, Va. Code 55.1-1202(F)):
    // the assigned PM must be notified directly, not left to discover a
    // silent bounce, AND must be pointed at an approved alternate service
    // method — a bounced email is not, by itself, legal service on the
    // tenant. This IS the caller's PM-contact context (lease.assigned_pm_email,
    // loaded above with everything else for this send) — sent right here,
    // in the same transaction as the delivery-status update, instead of
    // pushed back out to the route handler, so pm_bounce_notified_at is
    // never set without the notification actually having been attempted.
    await sendPmNotificationEmail(
      lease.assigned_pm_email,
      `ACTION NEEDED: 14-day notice email failed to deliver (notice ${params.noticeId})`,
      `The 14-day pay-or-quit notice email for notice ${params.noticeId} (unit ${lease.unit_label}) ` +
        `did not deliver successfully.\n\n` +
        `Email delivery failure alone is not legal service under Virginia law. Please complete service ` +
        `through an approved alternate method (e.g. certified mail or hand delivery, per your standard ` +
        `process/attorney guidance) and confirm the tenant's email address on file is correct.`
    );
  }

  await writeAuditLog(client, {
    companyId: "limehouse-pm",
    instanceId: "late-rent-notices",
    decisionId: `notice-${params.noticeId}`,
    actorType: params.sentAsFallback ? "fallback_decision_maker" : "pm",
    actorId: String(params.sendingPmId),
    eventType: "notice.sent",
    eventSummary: `Notice ${params.noticeId} sent (${finalDeliveryStatus}) to ${toRecipients.length} tenant(s).`,
    eventData: { deliveryStatus: finalDeliveryStatus, recipientCount: toRecipients.length },
    contextSnapshot: { noticeId: params.noticeId, leaseId: notice.lease_id, amountDue: liveBalance.balance },
    privacyCategory: "Disclosure",
    regulationTags: ["VRLTA"],
    riskLevel: "critical",
    legalBasis: "lease_section_46_electronic_delivery",
    retentionPolicy: "retain_7_years_post_tenancy",
    trace,
  });

  // Best-effort LeadSimple mirror (Jason's design: balance truth in
  // Buildium, communication record in LeadSimple) — an outbound-email note
  // + the notice PDF on the tenant's existing Deal in the Buildium Rental
  // Tenants pipeline. Runs strictly AFTER the send is committed and audit-
  // logged; any failure here (LeadSimple outage, rate limit, no matching
  // Deal) is logged and must never fail or roll back the send itself.
  try {
    const mirror = await mirrorNoticeToLeadSimple({
      noticeId: params.noticeId,
      recipientEmails: toRecipients.map((r) => r.email_address),
      recipientNames: toRecipients.map((r) => r.full_name ?? "Tenant"),
      subject,
      amountDue: formatCurrency(liveBalance.balance),
      deliveryStatus: finalDeliveryStatus,
      sentByPmName: sender?.display_name ?? `PM ${params.sendingPmId}`,
      sentAtIso: new Date().toISOString(),
      pdf: noticePdf,
      pdfFilename,
    });
    if (mirror.mirrored) {
      await writeAuditLog(client, {
        companyId: "limehouse-pm",
        instanceId: "late-rent-notices",
        decisionId: `notice-${params.noticeId}`,
        actorType: "system",
        actorId: "leadsimple_mirror",
        eventType: "notice.mirrored_to_leadsimple",
        eventSummary: `Notice ${params.noticeId} mirrored to LeadSimple deal "${mirror.dealName}" (note + PDF).`,
        eventData: { dealId: mirror.dealId },
        contextSnapshot: { noticeId: params.noticeId, leaseId: notice.lease_id },
        privacyCategory: "Disclosure",
        regulationTags: [],
        riskLevel: "low",
        legalBasis: "internal_record_keeping",
        retentionPolicy: "retain_7_years_post_tenancy",
        trace,
      });
    }
  } catch (err) {
    logWarn("LeadSimple mirror failed (notice already sent — this only affects the CRM copy)", {
      noticeId: params.noticeId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { sent: true, voided: false };
}

interface ResendBouncedRecipientParams {
  noticeId: number;
  recipientId: number;
  newEmail: string;
  correctingPmId: number;
}

// Re-delivers an already-sent notice to ONE recipient whose email bounced,
// after the PM has corrected the address on file. Deliberately NOT a call
// into sendNotice() above: this notice already transitioned to status =
// 'sent' (a permanent legal record), and sendNotice() only operates on
// status = 'draft'. Re-running the full draft->sent pipeline here would
// re-verify the live Buildium balance and could void or re-word an already-
// finalized legal document — wrong for "the tenant's copy never arrived,"
// which is a delivery problem, not a reason to re-litigate the amount owed.
// Same rendered content as the original send (frozen amount_due_at_send /
// days_late_at_send / notice_line_items 'send' snapshot), delivered only to
// the one corrected address — recipients who already received it
// successfully are not re-emailed.
export async function resendBouncedRecipient(
  client: PoolClient,
  params: ResendBouncedRecipientParams
): Promise<{ resent: boolean; stillBounced: boolean }> {
  const trace = startTrace();
  const env = loadEnv();

  const noticeResult = await client.query<{
    id: number;
    lease_id: number;
    status: string;
    letter_template_id: number;
    assigned_pm_id: number;
    sent_at: Date | null;
    amount_due_at_send: string | null;
    days_late_at_send: number | null;
  }>(
    `SELECT id, lease_id, status, letter_template_id, assigned_pm_id, sent_at,
            amount_due_at_send, days_late_at_send
     FROM notices WHERE id = $1 FOR UPDATE`,
    [params.noticeId]
  );
  if (noticeResult.rows.length === 0) {
    throw new SendBlockedError(`Notice ${params.noticeId} not found`, "not_found");
  }
  const notice = noticeResult.rows[0];
  if (notice.status !== "sent") {
    throw new SendBlockedError(
      `Notice ${params.noticeId} has not been sent yet (status=${notice.status}); nothing to resend.`,
      "not_sent"
    );
  }
  // notices.assigned_pm_id is NOT NULL (migration 0010), but node-postgres
  // returns bigint columns as strings at runtime regardless of the TS type
  // annotation above — coerce before comparing or this always mismatches.
  if (Number(notice.assigned_pm_id) !== params.correctingPmId) {
    throw new SendBlockedError("This notice is not assigned to you.", "not_assigned");
  }
  if (notice.amount_due_at_send == null || notice.days_late_at_send == null || notice.sent_at == null) {
    throw new SendBlockedError(
      `Notice ${params.noticeId} is missing its send-time snapshot; cannot rebuild the original notice to resend.`,
      "missing_send_snapshot"
    );
  }

  const recipientResult = await client.query<{
    id: number;
    recipient_type: string;
    email_address: string;
    delivery_status: string;
  }>(
    `SELECT id, recipient_type, email_address, delivery_status
     FROM notice_recipients WHERE id = $1 AND notice_id = $2 FOR UPDATE`,
    [params.recipientId, params.noticeId]
  );
  if (recipientResult.rows.length === 0) {
    throw new SendBlockedError("Recipient not found on this notice.", "recipient_not_found");
  }
  const recipient = recipientResult.rows[0];
  if (recipient.delivery_status !== "bounced") {
    throw new SendBlockedError(
      "This recipient's email did not bounce — nothing to resend.",
      "not_bounced"
    );
  }
  const oldEmail = recipient.email_address;

  if (env.SHADOW_MODE) {
    // Shadow mode: same no-op-and-log pattern as sendNotice()'s Step 3 above
    // — do not actually call Graph sendMail, and do not render the letter or
    // build a PDF for a send that will never happen. Correcting the email
    // address on file, though, IS a real action the PM took (independent of
    // whether the resend itself is suppressed) so that part of the flow
    // still runs. delivery_status is left as 'bounced' — nothing was
    // actually (re)delivered, so it must not read as sent/cleared.
    await client.query("UPDATE notice_recipients SET email_address = $1 WHERE id = $2", [
      params.newEmail,
      params.recipientId,
    ]);

    await writeAuditLog(client, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      decisionId: `notice-${params.noticeId}`,
      actorType: "pm",
      actorId: String(params.correctingPmId),
      eventType: "notice_recipient.email_corrected",
      eventSummary: `SHADOW MODE: PM corrected a bounced recipient's email on notice ${params.noticeId} (${oldEmail} -> ${params.newEmail}). No resend actually attempted.`,
      eventData: { shadowMode: true, oldEmail, newEmail: params.newEmail },
      contextSnapshot: { noticeId: params.noticeId, leaseId: notice.lease_id, recipientId: params.recipientId },
      privacyCategory: "Disclosure",
      regulationTags: ["VRLTA"],
      riskLevel: "high",
      legalBasis: "shadow_mode_no_op",
      retentionPolicy: "retain_7_years_post_tenancy",
      trace,
    });
    logInfo("shadow mode: bounced-recipient resend suppressed", {
      noticeId: params.noticeId,
      traceId: trace.trace_id,
    });

    return { resent: false, stillBounced: true };
  }

  const leaseResult = await client.query<{
    unit_label: string;
    multi_unit: boolean;
    property_address: string;
    address_line1: string;
    city: string;
    state: string;
    postal_code: string;
    assigned_pm_name: string;
  }>(
    `SELECT l.unit_label,
            (SELECT count(DISTINCT l2.unit_buildium_id) FROM leases l2 WHERE l2.property_id = l.property_id) > 1 AS multi_unit,
            (p.address_line1 || ', ' || p.city || ', ' || p.state) AS property_address,
            p.address_line1, p.city, p.state, p.postal_code,
            pm.display_name AS assigned_pm_name
     FROM leases l
     JOIN properties p ON p.id = l.property_id
     JOIN pm_users pm ON pm.id = $2
     WHERE l.id = $1`,
    [notice.lease_id, notice.assigned_pm_id]
  );
  const lease = leaseResult.rows[0];
  const unitDisplay = formatUnitDisplay(lease.unit_label, lease.multi_unit);
  const mailingAddress = formatMailingAddressLines(lease.address_line1, lease.city, lease.state, lease.postal_code, unitDisplay);

  const templateResult = await client.query<{ subject_line: string; body_markdown: string }>(
    "SELECT subject_line, body_markdown FROM letter_templates WHERE id = $1",
    [notice.letter_template_id]
  );
  const template = templateResult.rows[0];

  const allRecipientsResult = await client.query<{
    recipient_type: string;
    email_address: string;
    full_name: string | null;
  }>(
    `SELECT nr.recipient_type, nr.email_address, lt.full_name
     FROM notice_recipients nr
     LEFT JOIN lease_tenants lt ON lt.id = nr.lease_tenant_id
     WHERE nr.notice_id = $1`,
    [params.noticeId]
  );
  const allToRecipients = allRecipientsResult.rows.filter((r) => r.recipient_type === "to");
  const ccRecipients = allRecipientsResult.rows.filter((r) => r.recipient_type === "cc");

  const lineItemsResult = await client.query<{ bucket: string; amount: string }>(
    `SELECT bucket, amount FROM notice_line_items WHERE notice_id = $1 AND snapshot_stage = 'send'`,
    [params.noticeId]
  );
  const sumBucket = (bucket: string) =>
    lineItemsResult.rows.filter((li) => li.bucket === bucket).reduce((sum, li) => sum + Number(li.amount), 0);

  // Reconstruct the exact due_date used when this notice was originally
  // sent. due_date itself isn't stored on the notices row — only the
  // resulting days_late_at_send is — but calculateLateness() derives
  // daysLate as floor((sentAt - (dueDate + gracePeriodDays)) / 1 day), so
  // this is the inverse of that arithmetic, not a fresh re-derivation from
  // today's date (which would drift the due date forward the longer a
  // bounce goes uncorrected).
  const sentAtUtcDate = new Date(
    Date.UTC(notice.sent_at.getUTCFullYear(), notice.sent_at.getUTCMonth(), notice.sent_at.getUTCDate())
  );
  const dueDate = new Date(sentAtUtcDate);
  dueDate.setUTCDate(dueDate.getUTCDate() - notice.days_late_at_send);

  const { amount: courtCosts } = await getEstimatedCourtCosts(client);
  const { amount: attorneyFees } = await getEstimatedAttorneyFees(client);

  const mergeFields: MergeFields = {
    tenant_name: formatTenantNameList(allToRecipients.map((r) => r.full_name ?? "Tenant")),
    unit_label: unitDisplay,
    amount_due: formatCurrency(Number(notice.amount_due_at_send)),
    days_late: String(notice.days_late_at_send),
    due_date: formatDateMMDDYYYY(dueDate),
    // Original notice date, not today — this is a redelivery of the same
    // already-sent legal document, not a new notice.
    notice_date: formatDateMMDDYYYY(notice.sent_at),
    property_address: mailingAddress.line1,
    property_address_line2: mailingAddress.line2,
    pm_name: lease.assigned_pm_name,
    rent_amount_due: formatCurrency(sumBucket("rent")),
    late_fee_amount_due: formatCurrency(sumBucket("late_fee")),
    misc_amount_due: formatCurrency(sumBucket("other")),
    court_costs_amount: formatCurrency(courtCosts),
    attorney_fees_amount: formatCurrency(attorneyFees),
    total_fees_and_costs_amount: formatCurrency(courtCosts + attorneyFees),
  };

  const subject = renderTemplate(template.subject_line, mergeFields, { escapeForHtml: false });
  const renderedBody = renderTemplate(template.body_markdown, mergeFields, { escapeForHtml: false });
  const bodyHtml = renderNoticeBodyToHtml(renderedBody);
  const noticePdf = await generateNoticePdf(mergeFields, template.subject_line);

  const result = await sendGraphMail({
    subject,
    bodyHtml,
    toRecipients: [{ email: params.newEmail }],
    ccRecipients: ccRecipients.map((r) => ({ email: r.email_address })),
    attachments: [
      {
        name: `14-Day-Notice-${`${lease.property_address}${unitDisplay ? ` ${unitDisplay}` : ""}`.replace(/[^a-zA-Z0-9]+/g, "-")}.pdf`,
        contentType: "application/pdf",
        contentBytes: noticePdf,
      },
    ],
  });

  await client.query(
    "UPDATE notice_recipients SET email_address = $1, delivery_status = $2, bounced_at = $3 WHERE id = $4",
    [params.newEmail, result.success ? "sent" : "bounced", result.success ? null : new Date(), params.recipientId]
  );

  // Only clear the notice-level bounced flag once every recipient on it has
  // successfully delivered — a notice with three tenants where only one
  // bounced should still read as "bounced" until that one is fixed too.
  const remainingBounced = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM notice_recipients
     WHERE notice_id = $1 AND id != $2 AND delivery_status = 'bounced'`,
    [params.noticeId, params.recipientId]
  );
  const stillBounced = !result.success || Number(remainingBounced.rows[0].count) > 0;
  await client.query("UPDATE notices SET delivery_status = $1 WHERE id = $2", [
    stillBounced ? "bounced" : "sent",
    params.noticeId,
  ]);

  await writeAuditLog(client, {
    companyId: "limehouse-pm",
    instanceId: "late-rent-notices",
    decisionId: `notice-${params.noticeId}`,
    actorType: "pm",
    actorId: String(params.correctingPmId),
    eventType: "notice_recipient.email_corrected",
    eventSummary: `PM corrected a bounced recipient's email on notice ${params.noticeId} (${oldEmail} -> ${params.newEmail}) and ${result.success ? "resent successfully" : "attempted a resend, which also failed"}.`,
    eventData: { oldEmail, newEmail: params.newEmail, resendSucceeded: result.success },
    contextSnapshot: { noticeId: params.noticeId, leaseId: notice.lease_id, recipientId: params.recipientId },
    privacyCategory: "Disclosure",
    regulationTags: ["VRLTA"],
    riskLevel: "high",
    legalBasis: "lease_section_46_electronic_delivery",
    retentionPolicy: "retain_7_years_post_tenancy",
    trace,
  });

  return { resent: result.success, stillBounced };
}
