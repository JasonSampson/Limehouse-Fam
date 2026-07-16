import type { Pool } from "pg";
import { fetchLeaseOutstandingBalance } from "../buildium/client.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace, childSpan } from "../lib/trace.js";
import { sendPmNotificationEmail } from "../email/graphMailer.js";
import { logInfo } from "../lib/appLogger.js";
import { loadEnv } from "../config/env.js";

interface ExpiredNoticeRow {
  notice_id: number;
  lease_id: number;
  property_id: number;
  sent_at: Date;
  pm_email: string;
  pm_id: number;
  buildium_lease_id: string;
}

interface EscalationResult {
  checked: number;
  remindersSent: number;
}

// Fires exactly once per notice, the day after its 14-day window expires,
// if the balance is still unpaid: reminds the assigned PM to request
// eviction-filing funds from the property owner. The escalation_reminders
// table's UNIQUE(notice_id) is the actual "exactly once" guarantee — this
// job's WHERE clause is just the candidate filter, not the guard itself.
export async function runEscalationCheck(jobPool: Pool): Promise<EscalationResult> {
  const env = loadEnv();
  const trace = startTrace();

  const candidates = await jobPool.query<ExpiredNoticeRow>(
    `SELECT n.id AS notice_id, n.lease_id, l.property_id, n.sent_at,
            pm.email AS pm_email, pm.id AS pm_id, l.buildium_lease_id
     FROM notices n
     JOIN leases l ON l.id = n.lease_id
     JOIN pm_users pm ON pm.id = n.assigned_pm_id
     WHERE n.status = 'sent'
       AND n.sent_at IS NOT NULL
       AND n.sent_at + INTERVAL '14 days' < now()
       AND n.id NOT IN (SELECT notice_id FROM escalation_reminders)`
  );

  let remindersSent = 0;
  for (const row of candidates.rows) {
    const span = childSpan(trace);
    const liveBalance = await fetchLeaseOutstandingBalance(row.buildium_lease_id);

    if (liveBalance.balance <= 0) {
      // Paid in full during the 14-day window — no escalation needed, but
      // we still need to prevent re-checking this notice forever. Insert a
      // reminder row with balance 0 so it stops appearing as a candidate,
      // distinguishing "resolved, no action needed" from a real escalation
      // via balance_at_check = 0.
      await jobPool.query(
        `INSERT INTO escalation_reminders (notice_id, expiry_date, balance_at_check, sent_to_pm_id, sent_at)
         VALUES ($1, ($2::timestamptz + INTERVAL '14 days')::date, 0, $3, now())
         ON CONFLICT (notice_id) WHERE notice_id IS NOT NULL DO NOTHING`,
        [row.notice_id, row.sent_at, row.pm_id]
      );
      continue;
    }

    await sendPmNotificationEmail(
      row.pm_email,
      `Action needed: 14-day notice expired, balance still unpaid`,
      `The 14-day pay-or-quit notice for lease ${row.lease_id} expired and the tenant's balance ` +
        `is still unpaid (current balance per Buildium: $${liveBalance.balance.toFixed(2)}).\n\n` +
        `Please request eviction-filing funds from the property owner and proceed per your standard process.`
    );

    await jobPool.query(
      `INSERT INTO escalation_reminders (notice_id, expiry_date, balance_at_check, sent_to_pm_id, sent_at)
       VALUES ($1, ($2::timestamptz + INTERVAL '14 days')::date, $3, $4, now())
       ON CONFLICT (notice_id) WHERE notice_id IS NOT NULL DO NOTHING`,
      [row.notice_id, row.sent_at, liveBalance.balance, row.pm_id]
    );

    await writeAuditLog(jobPool, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      decisionId: `notice-${row.notice_id}`,
      actorType: "system",
      actorId: "escalation_check",
      eventType: "escalation.fired",
      eventSummary: env.SHADOW_MODE
        ? `SHADOW MODE: escalation reminder for notice ${row.notice_id} was NOT actually emailed to the PM (14-day window expired, balance still unpaid).`
        : `Escalation reminder sent to PM for notice ${row.notice_id}: 14-day window expired, balance still unpaid.`,
      eventData: { balance: liveBalance.balance, shadowModeSuppressed: env.SHADOW_MODE },
      contextSnapshot: { noticeId: row.notice_id, leaseId: row.lease_id },
      privacyCategory: "Aggregation",
      regulationTags: ["VRLTA"],
      riskLevel: "medium",
      propertyId: row.property_id,
      legalBasis: "operational_followup",
      retentionPolicy: "retain_7_years_post_tenancy",
      trace: span,
    });

    remindersSent += 1;
  }

  logInfo("escalation check complete", { traceId: trace.trace_id, checked: candidates.rows.length, remindersSent });
  return { checked: candidates.rows.length, remindersSent };
}
