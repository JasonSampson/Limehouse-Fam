import type { Pool } from "pg";
import { fetchLeaseOutstandingBalance, fetchGlAccountsById } from "../buildium/client.js";
import { classifyBalanceLines, rentEquivalentBalance } from "../lib/noticeLineItems.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace, childSpan } from "../lib/trace.js";
import { sendPmNotificationEmail } from "../email/graphMailer.js";
import { logInfo, logError } from "../lib/appLogger.js";
import { loadEnv } from "../config/env.js";
import { formatCurrency } from "../templates/renderTemplate.js";

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
  errors: string[];
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

  const glAccountsById = await fetchGlAccountsById();

  let remindersSent = 0;
  const errors: string[] = [];
  for (const row of candidates.rows) {
    const span = childSpan(trace);
    try {
      const liveBalance = await fetchLeaseOutstandingBalance(row.buildium_lease_id);
      // Only rent + late fees mean the tenant is still genuinely behind — a
      // leftover non-rent fee must not keep firing this reminder forever. Same
      // fix as dailyLatenessCheck.ts/staleDraftCheck.ts (2026-08-14) — see
      // rentEquivalentBalance's doc comment in noticeLineItems.ts.
      const classified = classifyBalanceLines(row.buildium_lease_id, liveBalance.balancesByGl, glAccountsById);
      const liveRentEquivalentBalance = rentEquivalentBalance(classified.bucketTotals);
      const nonRentBalanceRemaining = classified.bucketTotals.other;

      if (liveRentEquivalentBalance <= 0) {
        // Rent resolved during the 14-day window — no escalation needed, but
        // we still need to prevent re-checking this notice forever. Insert a
        // reminder row with balance 0 so it stops appearing as a candidate,
        // distinguishing "resolved, no action needed" from a real escalation
        // via balance_at_check = 0. A non-rent fee can still be genuinely
        // outstanding even here (Mason/TARS review finding, 2026-08-14) — the
        // audit entry says so explicitly rather than implying "$0 owed."
        await jobPool.query(
          `INSERT INTO escalation_reminders (notice_id, expiry_date, balance_at_check, sent_to_pm_id, sent_at)
           VALUES ($1, ($2::timestamptz + INTERVAL '14 days')::date, 0, $3, now())
           ON CONFLICT (notice_id) WHERE notice_id IS NOT NULL DO NOTHING`,
          [row.notice_id, row.sent_at, row.pm_id]
        );
        await writeAuditLog(jobPool, {
          companyId: "limehouse-pm",
          instanceId: "late-rent-notices",
          decisionId: `notice-${row.notice_id}`,
          actorType: "system",
          actorId: "escalation_check",
          eventType: "escalation.stood_down",
          eventSummary:
            `No escalation reminder needed for notice ${row.notice_id}: rent-equivalent balance resolved.` +
            (nonRentBalanceRemaining > 0
              ? ` Note: ${formatCurrency(nonRentBalanceRemaining)} in non-rent fees may still be outstanding on the ledger.`
              : ""),
          eventData: { nonRentBalanceRemaining },
          contextSnapshot: { noticeId: row.notice_id, leaseId: row.lease_id },
          privacyCategory: "Aggregation",
          regulationTags: ["VRLTA"],
          riskLevel: "low",
          propertyId: row.property_id,
          legalBasis: "operational_followup",
          retentionPolicy: "retain_7_years_post_tenancy",
          trace: span,
        });
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
    } catch (err) {
      // One lease's unclassifiable charge (or any other per-lease failure)
      // must not silently abort every OTHER expired notice's escalation
      // reminder for the day — same per-item isolation as
      // dailyLatenessCheck.ts's main loop (Mason/TARS review finding,
      // 2026-08-14: this loop previously had none).
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Notice ${row.notice_id} (lease ${row.lease_id}): ${message}`);
      logError("escalation check: error processing notice", { traceId: span.trace_id, noticeId: row.notice_id, error: message });
    }
  }

  logInfo("escalation check complete", { traceId: trace.trace_id, checked: candidates.rows.length, remindersSent });
  return { checked: candidates.rows.length, remindersSent, errors };
}
