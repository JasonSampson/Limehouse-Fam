import type { Pool } from "pg";
import { addBusinessDays } from "../lib/businessCalendar.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace, childSpan } from "../lib/trace.js";
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

interface PmReminderResult {
  remindersSent: number;
  jasonNotified: number;
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

  logInfo("pm reminder check complete", { traceId: trace.trace_id, remindersSent, jasonNotified });
  return { remindersSent, jasonNotified };
}
