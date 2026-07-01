import type { PoolClient } from "pg";
import { loadEnv } from "../config/env.js";
import { fetchLeaseOutstandingBalance } from "../buildium/client.js";
import { getDeMinimisThreshold } from "./config.js";
import { calculateLateness } from "./lateness.js";
import { renderTemplate, formatCurrency, type MergeFields } from "../templates/renderTemplate.js";
import { sendGraphMail } from "../email/graphMailer.js";
import { writeAuditLog } from "./auditLog.js";
import { startTrace } from "./trace.js";
import { logInfo } from "./appLogger.js";

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
    property_address: string;
    rent_due_day: number;
    grace_period_days: number;
    assigned_pm_name: string;
  }>(
    `SELECT l.buildium_lease_id, l.unit_label, l.rent_due_day, l.grace_period_days,
            (p.address_line1 || ', ' || p.city || ', ' || p.state) AS property_address,
            pm.display_name AS assigned_pm_name
     FROM leases l
     JOIN properties p ON p.id = l.property_id
     JOIN pm_users pm ON pm.id = $2
     WHERE l.id = $1`,
    [notice.lease_id, notice.assigned_pm_id]
  );
  const lease = leaseResult.rows[0];

  // Step 1: stale-draft protection. Live balance, not the cached draft figure.
  const liveBalance = await fetchLeaseOutstandingBalance(lease.buildium_lease_id);
  const { amount: deMinimisThreshold } = await getDeMinimisThreshold(client);

  if (liveBalance.balance <= deMinimisThreshold) {
    await client.query(
      `UPDATE notices SET status = 'voided', voided_at = now(),
         voided_reason = 'Tenant paid down below de minimis threshold before send (stale-draft check).',
         amount_due_at_send = $1
       WHERE id = $2`,
      [liveBalance.balance, params.noticeId]
    );

    await writeAuditLog(client, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      decisionId: `notice-${params.noticeId}`,
      actorType: params.sentAsFallback ? "fallback_decision_maker" : "pm",
      actorId: String(params.sendingPmId),
      eventType: "notice.voided",
      eventSummary: `Notice ${params.noticeId} voided at send time: balance dropped to ${formatCurrency(liveBalance.balance)}, below threshold.`,
      eventData: { liveBalance: liveBalance.balance, deMinimisThreshold },
      contextSnapshot: { noticeId: params.noticeId, leaseId: notice.lease_id },
      privacyCategory: "Aggregation",
      regulationTags: ["VRLTA"],
      riskLevel: "medium",
      legalBasis: "stale_draft_protection",
      retentionPolicy: "retain_7_years_post_tenancy",
      trace,
    });

    return { sent: false, voided: true };
  }

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

  let allSucceeded = true;
  for (const toRecipient of toRecipients) {
    const mergeFields: MergeFields = {
      tenant_name: toRecipient.full_name ?? "Tenant",
      unit_label: lease.unit_label,
      amount_due: formatCurrency(liveBalance.balance),
      days_late: String(daysLate),
      due_date: dueDate.toISOString().slice(0, 10),
      notice_date: new Date().toISOString().slice(0, 10),
      property_address: lease.property_address,
      pm_name: lease.assigned_pm_name,
    };

    const subject = renderTemplate(template.subject_line, mergeFields);
    const bodyHtml = renderTemplate(template.body_markdown, mergeFields).replace(/\n/g, "<br>");

    const result = await sendGraphMail({
      subject,
      bodyHtml,
      toRecipients: [{ email: toRecipient.email_address }],
      ccRecipients: ccRecipients.map((r) => ({ email: r.email_address })),
    });

    await client.query(
      "UPDATE notice_recipients SET delivery_status = $1, bounced_at = $2 WHERE id = $3",
      [result.success ? "sent" : "bounced", result.success ? null : new Date(), toRecipient.id]
    );

    if (!result.success) {
      allSucceeded = false;
    }
  }

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
    // Delivery-failure visibility: the assigned PM must be notified
    // directly, not left to discover a silent bounce. The actual PM
    // notification email send is handled by the caller (route handler),
    // which has the PM's contact context already loaded — this function
    // just guarantees the bounce is recorded and flagged.
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

  return { sent: true, voided: false };
}
