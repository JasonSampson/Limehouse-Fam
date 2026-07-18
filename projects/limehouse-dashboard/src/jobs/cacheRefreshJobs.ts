import { loadEnv, isRentEngineConnected } from "../config/env.js";
import {
  fetchLeasesByStatus,
  fetchActiveLeases,
  fetchAllLeases,
  fetchLeaseTransactions,
  fetchLeaseRecurringTransactions,
} from "../buildium/client.js";
import { upsertCachedMetric, recordCacheRefreshFailure } from "../db/metricCache.js";
import { startSyncRun, completeSyncRun, failSyncRun } from "../db/syncLog.js";
import {
  summarizeMonthlyCollectionRates,
  resolveLeaseBalancesPerMonth,
  monthsSinceYearsAgo,
  buildDuePerMonth,
  extractSecurityDepositWithheld,
  summarizeSecurityDepositWithheld,
  securityDepositMoveOutWindow,
} from "../kpi/rentCollection.js";
import { securityDepositWithheldRows, renewalRateRows } from "../kpi/leaseRows.js";
import { syncCallActivityForPeriod } from "../rentengine/callActivitySync.js";
import { resolvePeriod } from "../kpi/period.js";
import { logError, logInfo } from "../lib/logger.js";
import { summarizeRenewalRate, mostRecentRentEffectiveDate } from "../kpi/occupancy.js";
import { getOrFetchLeasingPerformanceForAllUnits } from "../rentengine/leasingPerformanceCache.js";

// ============================================================================
// Shared cache-refresh logic — ADDED 2026-07-18, per Jason directly
// (relayed from the LimeHQ project's investigation): most of the
// dashboard's cache-backed tiles ("Not connected"/"Couldn't load") had
// never actually been refreshed even once, because the sync endpoints
// below only ever ran when someone manually clicked something that called
// them — no button, no schedule, for 5 of 8 sync jobs. Each function here
// is the SAME logic the corresponding POST /api/sync/* route in
// syncRoutes.ts already ran, extracted so it has exactly one
// implementation, called from two places: the manual route (still exists,
// still works exactly as before) and the automatic scheduler below (new).
// See src/jobs/scheduler.ts for what actually calls these on a timer.
// ============================================================================

export async function refreshRentCollectionCache(): Promise<void> {
  const syncLogId = await startSyncRun("buildium", "rent_collection_cache_refresh");
  try {
    const activeLeases = await fetchActiveLeases();
    const monthsInWindow = monthsSinceYearsAgo(new Date(), 2);
    const duePerMonth = buildDuePerMonth(activeLeases, monthsInWindow);

    const balancesByLease: ReturnType<typeof resolveLeaseBalancesPerMonth>[] = [];
    for (const lease of activeLeases) {
      const transactions = await fetchLeaseTransactions(String(lease.Id));
      balancesByLease.push(resolveLeaseBalancesPerMonth(String(lease.Id), transactions));
    }

    const rentCollection = summarizeMonthlyCollectionRates(duePerMonth, balancesByLease.flat());
    await upsertCachedMetric("rent_collection_extended", "portfolio", "buildium", rentCollection);

    await completeSyncRun(syncLogId, activeLeases.length);
    logInfo("Rent collection sync completed", { syncLogId, leaseCount: activeLeases.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCacheRefreshFailure("rent_collection_extended", "portfolio", "buildium", message);
    await failSyncRun(syncLogId, message);
    logError("Rent collection sync failed", { syncLogId, error: message });
    throw err;
  }
}

export async function refreshSecurityDepositWithheldCache(): Promise<void> {
  const syncLogId = await startSyncRun("buildium", "security_deposit_withheld_cache_refresh");
  try {
    const pastLeases = await fetchLeasesByStatus(["Past"]);
    const window = securityDepositMoveOutWindow(new Date());
    const candidateLeases = pastLeases.filter(
      (l) => l.LeaseToDate !== null && l.LeaseToDate >= window.start && l.LeaseToDate <= window.end
    );

    const withheldByLeaseId = new Map<string, ReturnType<typeof extractSecurityDepositWithheld>>();
    for (const lease of candidateLeases) {
      const transactions = await fetchLeaseTransactions(String(lease.Id));
      withheldByLeaseId.set(String(lease.Id), extractSecurityDepositWithheld(String(lease.Id), transactions));
    }

    const rows = securityDepositWithheldRows(candidateLeases, withheldByLeaseId, window);
    const summary = summarizeSecurityDepositWithheld(rows);
    await upsertCachedMetric("security_deposit_withheld", "portfolio", "buildium", { summary, rows });

    await completeSyncRun(syncLogId, candidateLeases.length);
    logInfo("Security deposit withheld sync completed", { syncLogId, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCacheRefreshFailure("security_deposit_withheld", "portfolio", "buildium", message);
    await failSyncRun(syncLogId, message);
    logError("Security deposit withheld sync failed", { syncLogId, error: message });
    throw err;
  }
}

export async function refreshRenewalRateCache(): Promise<void> {
  const syncLogId = await startSyncRun("buildium", "renewal_rate_cache_refresh");
  try {
    const allLeases = await fetchAllLeases();
    const recentCutoff = new Date();
    recentCutoff.setUTCDate(recentCutoff.getUTCDate() - 400);
    const recentCutoffStr = recentCutoff.toISOString().slice(0, 10);
    const leasesToCheck = allLeases.filter(
      (l) => l.LeaseStatus !== "Past" || (l.LeaseToDate !== null && l.LeaseToDate >= recentCutoffStr)
    );

    const rentEffectiveDateByLeaseId = new Map<string, string>();
    for (const lease of leasesToCheck) {
      const recurring = await fetchLeaseRecurringTransactions(String(lease.Id));
      const rentDate = mostRecentRentEffectiveDate(
        recurring.map((r) => ({ firstOccurrenceDate: r.FirstOccurrenceDate, lineGlAccountIds: r.Lines.map((l) => l.GLAccountId) }))
      );
      if (rentDate) rentEffectiveDateByLeaseId.set(String(lease.Id), rentDate);
    }

    const now = new Date();
    const summary = summarizeRenewalRate(allLeases, rentEffectiveDateByLeaseId, now);
    const rows = renewalRateRows(allLeases, rentEffectiveDateByLeaseId, now);

    await upsertCachedMetric("renewal_rate", "portfolio", "buildium", { summary, rows });

    await completeSyncRun(syncLogId, leasesToCheck.length);
    logInfo("Renewal rate sync completed", { syncLogId, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCacheRefreshFailure("renewal_rate", "portfolio", "buildium", message);
    await failSyncRun(syncLogId, message);
    logError("Renewal rate sync failed", { syncLogId, error: message });
    throw err;
  }
}

export async function refreshCallActivityCache(): Promise<void> {
  if (!isRentEngineConnected()) return;
  const env = loadEnv();
  if (!env.RENTENGINE_ACCOUNT_ID) return;

  const syncLogId = await startSyncRun("rent_engine", "call_activity_sync");
  try {
    const range = resolvePeriod("this_month");
    const result = await syncCallActivityForPeriod(
      `${range.from}T00:00:00Z`,
      `${range.to}T23:59:59Z`,
      env.RENTENGINE_ACCOUNT_ID
    );

    await upsertCachedMetric("call_activity_this_month", "portfolio", "rent_engine", result);
    await completeSyncRun(syncLogId, result.prospectsScanned);
    logInfo("RentEngine call activity sync completed", { syncLogId, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCacheRefreshFailure("call_activity_this_month", "portfolio", "rent_engine", message);
    await failSyncRun(syncLogId, message);
    logError("RentEngine call activity sync failed", { syncLogId, error: message });
    throw err;
  }
}

// RentEngine per-unit leasing-performance data (feeds Property Health, Days
// on Market, Completion Rate, New Prospects, Showings Completed) — this one
// has no dedicated /api/sync/* route today; getOrFetchLeasingPerformanceForAllUnits
// (src/rentengine/leasingPerformanceCache.ts) already has its own 10-minute
// freshness check and in-flight-request dedupe, so calling it here on a
// schedule is enough to keep it warm — it no-ops if already fresh. Scoped
// to "this month," the same default range the dashboard's tiles request
// when no period is selected.
export async function refreshRentEngineLeasingPerformanceCache(): Promise<void> {
  if (!isRentEngineConnected()) return;
  const range = resolvePeriod("this_month");
  const result = await getOrFetchLeasingPerformanceForAllUnits(`${range.from}T00:00:00Z`, `${range.to}T23:59:59Z`);
  if (result.error) {
    logError("Scheduled RentEngine leasing-performance refresh failed", { error: result.error });
    return;
  }
  if (!result.cached) {
    logInfo("Scheduled RentEngine leasing-performance refresh completed", { unitCount: result.rows?.length ?? 0 });
  }
}
