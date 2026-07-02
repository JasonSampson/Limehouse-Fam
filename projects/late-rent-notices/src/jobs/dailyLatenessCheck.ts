import type { Pool } from "pg";
import { loadEnv } from "../config/env.js";
import { syncBuildiumData } from "../buildium/sync.js";
import { fetchOutstandingBalances } from "../buildium/client.js";
import { calculateLateness } from "../lib/lateness.js";
import { getDeMinimisThreshold } from "../lib/config.js";
import { fetchAndClassifyLeaseCharges, insertNoticeLineItems } from "../lib/noticeLineItems.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace, childSpan } from "../lib/trace.js";
import { logInfo, logError } from "../lib/appLogger.js";

interface LeaseRow {
  id: number;
  property_id: number;
  rent_due_day: number;
  grace_period_days: number;
  buildium_lease_id: string;
}

interface DailyJobResult {
  leasesChecked: number;
  noticesDrafted: number;
  excludedCount: number;
  errors: string[];
}

// The daily job, scheduled for 10:00 EST (after the prior day's Buildium
// payment postings have settled — see scheduler.ts for the business-day-
// aware scheduling logic). This function assumes it is being called at
// the right time; it does not itself decide whether "now" is correct.
//
// Restructured after testing against the real Buildium account: a single
// bulk call to /leases/outstandingbalances replaces what was previously an
// N+1 per-lease balance fetch — that endpoint only returns leases that
// actually have a balance owed (zero/credit-balance leases are absent from
// the results), and it also returns EvictionPendingDate per lease, so the
// eviction-pending auto-exclusion backstop comes for free in the same call
// that gets the balance, not a separate lookup.
export async function runDailyLatenessCheck(jobPool: Pool): Promise<DailyJobResult> {
  const env = loadEnv();
  const trace = startTrace();
  const errors: string[] = [];
  let noticesDrafted = 0;
  let excludedCount = 0;

  await syncBuildiumData(jobPool);

  const { id: deMinimisConfigId, amount: deMinimisThreshold } = await getDeMinimisThreshold(jobPool);
  const outstandingBalances = await fetchOutstandingBalances();

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const balanceRow of outstandingBalances) {
    const leaseSpan = childSpan(trace);
    try {
      const leaseResult = await jobPool.query<LeaseRow>(
        "SELECT id, property_id, rent_due_day, grace_period_days, buildium_lease_id FROM leases WHERE buildium_lease_id = $1 AND lease_status = 'Active'",
        [balanceRow.leaseId]
      );
      if (leaseResult.rows.length === 0) {
        // Has a balance per Buildium but isn't in our local active-lease
        // cache yet (sync ordering, or a lease that's Active in Buildium
        // but our sync hasn't caught up) — skip this run, pick up next.
        continue;
      }
      const lease = leaseResult.rows[0];

      // Eviction-pending auto-exclusion backstop (Jason's explicit choice,
      // alongside the manual exclusion list — not a replacement for it).
      if (balanceRow.evictionPendingDate !== null) {
        excludedCount += 1;
        await writeAuditLog(jobPool, {
          companyId: "limehouse-pm",
          instanceId: "late-rent-notices",
          actorType: "system",
          actorId: "daily_lateness_check",
          eventType: "exclusion.applied",
          eventSummary: `Lease excluded from late-rent check: Buildium reports eviction pending since ${balanceRow.evictionPendingDate}`,
          eventData: { source: "buildium_eviction_pending_backstop", evictionPendingDate: balanceRow.evictionPendingDate },
          contextSnapshot: { leaseId: lease.id },
          privacyCategory: "Decisional Interference",
          regulationTags: ["VRLTA"],
          riskLevel: "low",
          propertyId: lease.property_id,
          legalBasis: "eviction_pending_backstop",
          retentionPolicy: "retain_7_years_post_tenancy",
          trace: leaseSpan,
        });
        continue;
      }

      // Manual exclusion list (payment plan / dispute / other) — separate
      // from the Buildium eviction-pending backstop above.
      const exclusion = await jobPool.query(
        "SELECT id, reason_category FROM exclusions WHERE lease_id = $1 AND active = true",
        [lease.id]
      );
      if (exclusion.rows.length > 0) {
        excludedCount += 1;
        await writeAuditLog(jobPool, {
          companyId: "limehouse-pm",
          instanceId: "late-rent-notices",
          actorType: "system",
          actorId: "daily_lateness_check",
          eventType: "exclusion.applied",
          eventSummary: `Lease excluded from late-rent check (category: ${exclusion.rows[0].reason_category})`,
          eventData: { source: "manual_exclusion_list", excludedCategory: exclusion.rows[0].reason_category },
          contextSnapshot: { leaseId: lease.id },
          privacyCategory: "Decisional Interference",
          regulationTags: ["VRLTA"],
          riskLevel: "low",
          propertyId: lease.property_id,
          legalBasis: "manual_exclusion_list",
          retentionPolicy: "retain_7_years_post_tenancy",
          trace: leaseSpan,
        });
        continue;
      }

      const lateness = calculateLateness({
        rentDueDay: lease.rent_due_day,
        gracePeriodDays: lease.grace_period_days,
        balance: balanceRow.balance,
        today,
        deMinimisThreshold,
      });

      if (!lateness.qualifiesForNotice) {
        continue;
      }

      // Duplicate guard: UNIQUE(lease_id, due_date) on late_cycles means a
      // second daily-job run for the same due date is a no-op insert, not
      // a second notice.
      const cycleResult = await jobPool.query<{ id: number }>(
        `INSERT INTO late_cycles (lease_id, due_date, de_minimis_config_id, opened_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (lease_id, due_date) DO NOTHING
         RETURNING id`,
        [lease.id, lateness.dueDate.toISOString().slice(0, 10), deMinimisConfigId]
      );

      let lateCycleId: number;
      if (cycleResult.rows.length > 0) {
        lateCycleId = cycleResult.rows[0].id;
      } else {
        const existing = await jobPool.query<{ id: number }>(
          "SELECT id FROM late_cycles WHERE lease_id = $1 AND due_date = $2",
          [lease.id, lateness.dueDate.toISOString().slice(0, 10)]
        );
        lateCycleId = existing.rows[0].id;
      }

      const activeTemplate = await jobPool.query<{ id: number }>(
        "SELECT id FROM letter_templates WHERE is_active = true LIMIT 1"
      );
      if (activeTemplate.rows.length === 0) {
        throw new Error("No active letter_templates row found — cannot draft notices.");
      }

      const assignedPm = await jobPool.query<{ pm_user_id: number }>(
        "SELECT pm_user_id FROM pm_property_assignments WHERE property_id = $1 LIMIT 1",
        [lease.property_id]
      );
      if (assignedPm.rows.length === 0) {
        errors.push(`Lease ${lease.id}: no PM assigned to property ${lease.property_id}, skipping draft`);
        continue;
      }

      const draftResult = await jobPool.query<{ id: number }>(
        `INSERT INTO notices (
           late_cycle_id, lease_id, status, amount_due_at_draft, days_late_at_draft,
           letter_template_id, assigned_pm_id
         ) VALUES ($1,$2,'draft',$3,$4,$5,$6)
         ON CONFLICT (late_cycle_id) DO NOTHING
         RETURNING id`,
        [
          lateCycleId,
          lease.id,
          balanceRow.balance,
          lateness.daysLate,
          activeTemplate.rows[0].id,
          assignedPm.rows[0].pm_user_id,
        ]
      );

      if (draftResult.rows.length === 0) {
        // Duplicate guard caught it — a notice already exists for this
        // late cycle. Nothing to do.
        continue;
      }

      const noticeId = draftResult.rows[0].id;
      noticesDrafted += 1;

      // Itemized charge breakdown, snapshotted at draft time (migration
      // 0038). If any charge line can't be safely classified into
      // rent/late_fee/other, fetchAndClassifyLeaseCharges throws
      // UnclassifiedChargeBlockedError — caught by this lease's try/catch
      // below like any other per-lease failure, landing in `errors` for a
      // human to review. The notice row itself is intentionally left in
      // place without line items rather than rolled back, matching this
      // job's existing no-transaction, best-effort-per-lease pattern; a
      // notice missing its itemization is visibly incomplete (Judge/TARS
      // can check for notices with zero notice_line_items rows), which is
      // safer than either silently guessing a bucket or aborting the whole
      // day's run over one lease's chart-of-accounts problem.
      const classifiedBalance = await fetchAndClassifyLeaseCharges(lease.buildium_lease_id);
      await insertNoticeLineItems(jobPool, noticeId, "draft", classifiedBalance.positiveLines);

      // Recipients: every listed tenant on the lease gets a "to" entry
      // (roommates/co-signers all receive the notice, not just one), plus
      // the assigned PM as "cc". Email addresses are frozen here, at draft
      // time, per notice_recipients.email_address design intent.
      const tenants = await jobPool.query<{ id: number; email: string }>(
        "SELECT id, email FROM lease_tenants WHERE lease_id = $1",
        [lease.id]
      );
      for (const tenant of tenants.rows) {
        await jobPool.query(
          `INSERT INTO notice_recipients (notice_id, recipient_type, lease_tenant_id, email_address)
           VALUES ($1, 'to', $2, $3)`,
          [noticeId, tenant.id, tenant.email]
        );
      }
      const pmEmail = await jobPool.query<{ email: string }>(
        "SELECT email FROM pm_users WHERE id = $1",
        [assignedPm.rows[0].pm_user_id]
      );
      await jobPool.query(
        `INSERT INTO notice_recipients (notice_id, recipient_type, pm_user_id, email_address)
         VALUES ($1, 'cc', $2, $3)`,
        [noticeId, assignedPm.rows[0].pm_user_id, pmEmail.rows[0].email]
      );

      await writeAuditLog(jobPool, {
        companyId: "limehouse-pm",
        instanceId: "late-rent-notices",
        decisionId: `notice-${noticeId}`,
        actorType: "system",
        actorId: "daily_lateness_check",
        eventType: "notice.drafted",
        eventSummary: `Draft 14-day notice created for lease ${lease.id}, ${lateness.daysLate} days late`,
        eventData: {
          shadowMode: env.SHADOW_MODE,
          deMinimisConfigId,
          gracePeriodDays: lease.grace_period_days,
        },
        contextSnapshot: {
          leaseId: lease.id,
          noticeId,
          daysLate: lateness.daysLate,
          amountDue: balanceRow.balance,
        },
        privacyCategory: "Aggregation",
        regulationTags: ["VRLTA"],
        riskLevel: "high",
        propertyId: lease.property_id,
        legalBasis: "lease_terms_and_vrlta_55.1-1245",
        retentionPolicy: "retain_7_years_post_tenancy",
        trace: leaseSpan,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Lease (buildium id ${balanceRow.leaseId}): ${message}`);
      logError("daily lateness check: error processing lease", {
        traceId: leaseSpan.trace_id,
        error: message,
      });
    }
  }

  logInfo("daily lateness check complete", {
    traceId: trace.trace_id,
    leasesChecked: outstandingBalances.length,
    noticesDrafted,
    excludedCount,
    errorCount: errors.length,
  });

  return { leasesChecked: outstandingBalances.length, noticesDrafted, excludedCount, errors };
}
