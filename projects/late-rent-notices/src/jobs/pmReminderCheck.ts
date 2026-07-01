import type { Pool } from "pg";
import { addBusinessDays } from "../lib/businessCalendar.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace, childSpan, type Trace } from "../lib/trace.js";
import { sendAlert } from "../email/sendAlert.js";
import { sendPmNotificationEmail } from "../email/graphMailer.js";
import { loadEnv } from "../config/env.js";
import { logInfo } from "../lib/appLogger.js";

interface DraftRow {
  id: number;
  drafted_at: Date;
  assigned_pm_id: number;
  pm_email: string;
  pm_reminder_sent_at: Date | null;
}

interface OverduePromiseRow {
  contact_attempt_id: number;
  lease_id: number;
  promised_pay_date: Date;
  logged_by_pm_id: number;
  pm_email: string;
}

interface PmReminderResult {
  remindersSent: number;
  jasonNotified: number;
  promiseReminders?: number;
}

// Two-stage nudge for an unsent draft:
//   1. A reminder to the assigned PM (once per draft is enough for v1 —
//      no reminder-spam logic needed since the next stage handles true
//      inaction).
//   2. If still unsent by the 2nd business day after the draft was
//      created, Jason is notified that he MAY act as fallback decision-
//      maker for that lease — this job only NOTIFIES; it never sends on
//      Jason's behalf. The actual fallback send is a separate, explicit
//      action Jason takes in the dashboard (src/lib/sendAsFallback.ts),
//      gated by fresh re-auth + ledger verification + the hard ceiling.
export async function runPmReminderCheck(jobPool: Pool): Promise<PmReminderResult> {
  const env = loadEnv();
  const trace = startTrace();
  let remindersSent = 0;
  let jasonNotified = 0;

  const drafts = await jobPool.query<DraftRow>(
    `SELECT n.id, n.drafted_at, n.assigned_pm_id, pm.email AS pm_email,
            n.pm_reminder_sent_at
     FROM notices n
     JOIN pm_users pm ON pm.id = n.assigned_pm_id
     WHERE n.status = 'draft'`
  );

  for (const draft of drafts.rows) {
    const span = childSpan(trace);
    const secondBusinessDayDeadline = addBusinessDays(draft.drafted_at, 2);
    const now = new Date();

    if (now < secondBusinessDayDeadline) {
      // Not yet past the 2-business-day mark. Send the PM nudge exactly
      // once per draft — pm_reminder_sent_at is the actual "already
      // reminded" guard (a prior version of this check read an unrelated
      // bounce-notification column and never set anything, so it re-sent
      // this email on every single run before the deadline).
      if (draft.pm_reminder_sent_at === null) {
        await sendPmNotificationEmail(
          draft.pm_email,
          "Reminder: a late-rent notice draft is waiting on your review",
          `A 14-day pay-or-quit notice draft (notice ${draft.id}) has been waiting since ` +
            `${draft.drafted_at.toISOString()}. Please review and send (or void with a reason) ` +
            `in the dashboard.\n\nIf this isn't sent by ${secondBusinessDayDeadline.toISOString()}, ` +
            `Jason will be notified as the fallback decision-maker for this lease.`
        );
        await jobPool.query("UPDATE notices SET pm_reminder_sent_at = now() WHERE id = $1", [draft.id]);
        remindersSent += 1;
      }
      continue;
    }

    // Past the 2-business-day deadline — notify Jason via the same Teams
    // channel as job-failure alerts. This is a business escalation, not an
    // infra failure, but it's still "needs Jason's attention right now,"
    // and Teams is the channel he chose for exactly that. This is a
    // notification only; it does not perform any send.
    await sendAlert({
      to: env.JASON_ALERT_EMAIL,
      subject: "Fallback decision-maker action available: late-rent notice unsent past deadline",
      body:
        `Notice ${draft.id} has been a draft since ${draft.drafted_at.toISOString()} and was not sent ` +
        `by the assigned PM within 2 business days. You may act as the fallback decision-maker for ` +
        `this specific lease in the dashboard, subject to the same ledger-verification step and the ` +
        `hard ceiling (max 1 fallback send per PM per month, or 10% of all notices in 30 days).`,
    });

    await writeAuditLog(jobPool, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      decisionId: `notice-${draft.id}`,
      actorType: "system",
      actorId: "pm_reminder_check",
      eventType: "fallback.notification_sent",
      eventSummary: `Notice ${draft.id} unsent past 2-business-day deadline; Jason notified as fallback decision-maker (not yet acted).`,
      eventData: { secondBusinessDayDeadline: secondBusinessDayDeadline.toISOString() },
      contextSnapshot: { noticeId: draft.id, assignedPmId: draft.assigned_pm_id },
      privacyCategory: "N/A",
      regulationTags: [],
      riskLevel: "high",
      legalBasis: "governance_fallback_design",
      retentionPolicy: "retain_7_years_post_tenancy",
      trace: span,
    });

    jasonNotified += 1;
  }

  const promiseReminders = await runOverduePromiseCheck(jobPool, trace);

  logInfo("pm reminder check complete", {
    traceId: trace.trace_id,
    remindersSent,
    jasonNotified,
    promiseReminders,
  });
  return { remindersSent, jasonNotified, promiseReminders };
}

// Second, independent source of reminders in this same job: a tenant who
// told a PM/admin_assistant "I'll pay by <date>" (contact_attempts.outcome =
// 'promised_to_pay'), where that date has now passed. This has NOTHING to do
// with the notice-draft pipeline above — it can fire even when no notice
// exists at all for that lease.
//
// Exactly-once guard: escalation_reminders.contact_attempt_id has a partial
// UNIQUE index (migration 0025), so INSERT ... ON CONFLICT DO NOTHING is the
// actual duplicate-prevention mechanism, not the candidate WHERE clause below
// — same division of responsibility as runEscalationCheck.ts already uses
// for notice_id. This is deliberately NOT built the way migration 0020 had
// to fix (a column that looked like a guard but was never actually checked
// or set) — the guard here is a real DB constraint, checked by the INSERT's
// own conflict outcome, not by re-reading a timestamp column afterward.
//
// "No resolving contact logged since" (per the spec) is read here as: this
// promised_to_pay attempt is still the MOST RECENT contact_attempts row for
// that lease. If the PM has logged anything newer (paid, disputed, a new
// promise, whatever), the old promise is superseded and should not still
// generate a nag about a stale date — the newer entry is the current state
// of that conversation.
async function runOverduePromiseCheck(jobPool: Pool, trace: Trace): Promise<number> {
  const candidates = await jobPool.query<OverduePromiseRow>(
    `SELECT ca.id AS contact_attempt_id, ca.lease_id, ca.promised_pay_date,
            ca.logged_by_pm_id, pm.email AS pm_email
     FROM contact_attempts ca
     JOIN pm_users pm ON pm.id = ca.logged_by_pm_id
     WHERE ca.outcome = 'promised_to_pay'
       AND ca.promised_pay_date < current_date
       AND ca.id NOT IN (
         SELECT contact_attempt_id FROM escalation_reminders WHERE contact_attempt_id IS NOT NULL
       )
       AND ca.id = (
         SELECT newest.id FROM contact_attempts newest
         WHERE newest.lease_id = ca.lease_id
         ORDER BY newest.occurred_at DESC, newest.id DESC
         LIMIT 1
       )`
  );

  let promiseReminders = 0;
  for (const row of candidates.rows) {
    const span = childSpan(trace);

    // ON CONFLICT DO NOTHING is the real guard against a duplicate send —
    // see comment above. If two overlapping job runs somehow raced here,
    // only one would win the insert; only that run counts and sends.
    const insertResult = await jobPool.query(
      `INSERT INTO escalation_reminders (contact_attempt_id, expiry_date, balance_at_check, sent_to_pm_id, sent_at)
       VALUES ($1, $2, 0, $3, now())
       ON CONFLICT (contact_attempt_id) WHERE contact_attempt_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [row.contact_attempt_id, row.promised_pay_date, row.logged_by_pm_id]
    );
    if (insertResult.rows.length === 0) {
      // Another run already claimed this one — skip sending.
      continue;
    }

    await sendPmNotificationEmail(
      row.pm_email,
      "Reminder: a tenant's promised payment date has passed",
      `A tenant on lease ${row.lease_id} promised to pay by ${row.promised_pay_date.toISOString().slice(0, 10)}, ` +
        `and that date has passed with no newer contact logged since. Please follow up and log the outcome ` +
        `in the dashboard.`
    );

    await writeAuditLog(jobPool, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      decisionId: `contact-attempt-${row.contact_attempt_id}`,
      actorType: "system",
      actorId: "pm_reminder_check",
      eventType: "contact_attempt.promise_overdue_reminder_sent",
      eventSummary: `Promised-pay-date for contact attempt ${row.contact_attempt_id} (lease ${row.lease_id}) passed; PM reminded.`,
      eventData: { promisedPayDate: row.promised_pay_date.toISOString().slice(0, 10) },
      contextSnapshot: { leaseId: row.lease_id, contactAttemptId: row.contact_attempt_id },
      privacyCategory: "Aggregation",
      regulationTags: [],
      riskLevel: "low",
      legalBasis: "operational_followup",
      retentionPolicy: "retain_7_years_post_tenancy",
      trace: span,
    });

    promiseReminders += 1;
  }

  return promiseReminders;
}
