import { loadEnv, isRentEngineConnected, isLeadSimpleConnected } from "../config/env.js";
import {
  fetchLeasesByStatus,
  fetchActiveLeases,
  fetchAllLeases,
  fetchLeaseTransactions,
  fetchLeaseRecurringTransactions,
  fetchActiveManagedUnits,
  fetchOutstandingBalances,
  fetchVendors,
  fetchBankAccounts,
  fetchBankAccountReconciliations,
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
import { resolvePeriod, periodToSnapshotLabel } from "../kpi/period.js";
import { logError, logInfo } from "../lib/logger.js";
import { summarizeOccupancy, summarizeDelinquencyRate, summarizeRenewalRate, mostRecentRentEffectiveDate } from "../kpi/occupancy.js";
import { getOrFetchLeasingPerformanceForAllUnits } from "../rentengine/leasingPerformanceCache.js";
import { summarizeDaysOnMarket, summarizeShowingCompletionRate, fetchUnits } from "../rentengine/client.js";
import {
  summarizeReconciliationAccuracy,
  summarizeRentProcessingAccuracy,
  summarizeVendorCompliance,
  summarize1099Compliance,
  type ReconciliationAccuracyInput,
} from "../kpi/bookkeeperMetrics.js";
import {
  fetchApplicationProcesses,
  summarizeApplicationProcessingTime,
  fetchApplicationsWithTasksForResponseTimeliness,
  summarizeApplicantResponseTimeliness,
  fetchLeaseRenewalProcesses,
  summarizeLeaseRenewalRate,
  fetchMoveInTasks,
  summarizePropertyReadiness,
  fetchResidentResponseTasks,
  summarizeResidentResponseTime,
} from "../leadsimple/client.js";
import { getExcludedPropertyIds } from "../kpi/terminatedProperties.js";
import { getKpiDefinitionIdsByName, upsertKpiSnapshot } from "../db/kpiRepository.js";

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

// ADDED 2026-07-19, per Jason directly: this used to be manual-only (see
// the POST /api/sync/team-performance-kpis route this was extracted from,
// same pattern as every other job above) — meaning dashboard_kpi_snapshots
// only ever got a row for whatever quarter someone happened to click "sync"
// during. Scheduling it means the Quarterly Trend chart on the Team
// Performance tab actually accumulates real history going forward, instead
// of staying permanently empty. Writes into dashboard_kpi_snapshots for
// the CURRENT quarter — Neo's schema is designed to hold one row per
// (kpi_definition, quarter), so re-running this mid-quarter just updates
// that same quarter's row (upsertKpiSnapshot's ON CONFLICT), it never
// creates duplicates or corrupts a past quarter.
async function writeSnapshotForEveryDisplayGroup(
  role: string,
  kpiName: string,
  period: string,
  periodStart: string,
  periodEnd: string,
  hasData: boolean,
  actualValue: number | null,
  targetValue: number,
  higherIsBetter: boolean,
  sourceSystem: string
): Promise<void> {
  const definitionIds = await getKpiDefinitionIdsByName(role, kpiName);
  for (const kpiDefinitionId of definitionIds) {
    await upsertKpiSnapshot({
      kpiDefinitionId,
      period,
      periodStart,
      periodEnd,
      hasData,
      actualValue,
      targetValue,
      higherIsBetter,
      sourceSystem,
    });
  }
}

export async function runTeamPerformanceKpisSync(): Promise<Record<string, unknown>> {
  const syncLogId = await startSyncRun("buildium", "team_performance_kpis_sync");
  try {
    const now = new Date();
    const period = periodToSnapshotLabel("this_quarter", now);
    const quarterStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), quarterStartMonth, 1)).toISOString().slice(0, 10);
    // Stored on the snapshot row as the quarter's real calendar end — but
    // NEVER passed as the "to" bound into a KPI calculation itself (same
    // future-dates issue already fixed elsewhere: This Month/Quarter/Year
    // reaching past today). asOfDate clamps every KPI calculation's "to"
    // bound to today; periodEnd is kept separately, for storage only.
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), quarterStartMonth + 3, 0)).toISOString().slice(0, 10);
    const asOfDate = now.toISOString().slice(0, 10);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const monthEnd = now.toISOString().slice(0, 10);

    // Portfolio Manager
    const [allUnits, activeLeases, excludedPropertyIds] = await Promise.all([
      fetchActiveManagedUnits(),
      fetchActiveLeases(),
      getExcludedPropertyIds(),
    ]);
    const units = allUnits.filter((u) => !excludedPropertyIds.has(String(u.PropertyId)));
    const occupancy = summarizeOccupancy(units.length, activeLeases);
    await writeSnapshotForEveryDisplayGroup(
      "portfolio_manager", "Portfolio Occupancy Rate", period, periodStart, periodEnd,
      true, occupancy.occupancyRatePercent, 95, true, "buildium"
    );

    const balances = await fetchOutstandingBalances();
    const delinquencyRate = summarizeDelinquencyRate(balances, activeLeases);
    await writeSnapshotForEveryDisplayGroup(
      "portfolio_manager", "Delinquency Rate", period, periodStart, periodEnd,
      delinquencyRate.ratePercent !== null, delinquencyRate.ratePercent, 3, false, "buildium"
    );

    // Lease Renewal Rate is a fixed trailing-12-month window (the vendor's
    // own label reads "(12 mo)"), scoped by each process's created_at.
    if (isLeadSimpleConnected()) {
      const renewalWindowStart = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const renewalProcesses = await fetchLeaseRenewalProcesses();
      if (renewalProcesses.connected && renewalProcesses.data) {
        const renewalRate = summarizeLeaseRenewalRate(renewalProcesses.data, renewalWindowStart, asOfDate);
        await writeSnapshotForEveryDisplayGroup(
          "portfolio_manager", "Lease Renewal Rate", period, periodStart, periodEnd,
          renewalRate.ratePercent !== null, renewalRate.ratePercent, 70, true, "lead_simple"
        );
      }
    }

    if (isRentEngineConnected()) {
      const leasingPerf = await getOrFetchLeasingPerformanceForAllUnits(monthStart, monthEnd);
      if (leasingPerf.connected && leasingPerf.rows) {
        const dom = summarizeDaysOnMarket(leasingPerf.rows);
        await writeSnapshotForEveryDisplayGroup(
          "portfolio_manager", "Days on Market", period, periodStart, periodEnd,
          dom.avgDaysOnMarket !== null, dom.avgDaysOnMarket, 21, false, "rent_engine"
        );

        // Portfolio Assistant — no-ops until a matching KPI definition
        // exists (getKpiDefinitionIdsByName finds none), starts writing
        // real snapshots the moment that migration lands, no code change
        // needed then.
        const reUnits = await fetchUnits();
        if (reUnits.connected && reUnits.data) {
          const showingCompletion = summarizeShowingCompletionRate(leasingPerf.rows, reUnits.data);
          await writeSnapshotForEveryDisplayGroup(
            "portfolio_assistant", "Showing Completion Rate", period, periodStart, periodEnd,
            showingCompletion.ratePercent !== null, showingCompletion.ratePercent, 95, true, "rent_engine"
          );
        }
      }
    }

    // Property Readiness / Resident Response Time — ADDED 2026-07-20, per
    // Jason directly, against real vendor screenshots. Both are scored
    // cumulatively over the whole quarter so far (periodStart to
    // asOfDate), same window shape as Lease Renewal Rate above, not the
    // "current month only" window Days on Market/Showing Completion Rate
    // use.
    if (isLeadSimpleConnected()) {
      const moveInTasks = await fetchMoveInTasks(periodStart);
      if (moveInTasks.connected && moveInTasks.data) {
        const propertyReadiness = summarizePropertyReadiness(moveInTasks.data, periodStart, asOfDate);
        await writeSnapshotForEveryDisplayGroup(
          "portfolio_assistant", "Property Readiness", period, periodStart, periodEnd,
          propertyReadiness.ratePercent !== null, propertyReadiness.ratePercent, 100, true, "lead_simple"
        );
      }

      const residentTasks = await fetchResidentResponseTasks(periodStart);
      if (residentTasks.connected && residentTasks.data) {
        const residentResponse = summarizeResidentResponseTime(residentTasks.data, periodStart, asOfDate);
        await writeSnapshotForEveryDisplayGroup(
          "portfolio_assistant", "Resident Response Time", period, periodStart, periodEnd,
          residentResponse.averageHours !== null, residentResponse.averageHours, 24, false, "lead_simple"
        );
      }
    }

    // Bookkeeper
    const vendors = await fetchVendors();
    const vendorCompliance = summarizeVendorCompliance(vendors);
    await writeSnapshotForEveryDisplayGroup(
      "bookkeeper", "Vendor Compliance", period, periodStart, periodEnd,
      vendorCompliance.compliancePercent !== null, vendorCompliance.compliancePercent, 100, true, "buildium"
    );
    const nineNine = summarize1099Compliance(vendors);
    await writeSnapshotForEveryDisplayGroup(
      "bookkeeper", "1099 Compliance", period, periodStart, periodEnd,
      nineNine.compliancePercent !== null, nineNine.compliancePercent, 100, true, "buildium"
    );

    const bankAccounts = await fetchBankAccounts();
    const reconInputs: ReconciliationAccuracyInput[] = [];
    for (const account of bankAccounts) {
      const { reconcilable, reconciliations } = await fetchBankAccountReconciliations(account.Id);
      reconInputs.push({ account, reconcilable, reconciliations });
    }
    const reconciliationAccuracy = summarizeReconciliationAccuracy(reconInputs, periodStart, asOfDate);
    await writeSnapshotForEveryDisplayGroup(
      "bookkeeper", "Reconciliation Accuracy", period, periodStart, periodEnd,
      reconciliationAccuracy.accuracyPercent !== null, reconciliationAccuracy.accuracyPercent, 100, true, "buildium"
    );

    const transactionsByLease: Awaited<ReturnType<typeof fetchLeaseTransactions>>[] = [];
    for (const lease of activeLeases) {
      transactionsByLease.push(await fetchLeaseTransactions(String(lease.Id)));
    }
    const rentProcessingAccuracy = summarizeRentProcessingAccuracy(transactionsByLease, periodStart, asOfDate);
    await writeSnapshotForEveryDisplayGroup(
      "bookkeeper", "Rent Processing Accuracy", period, periodStart, periodEnd,
      rentProcessingAccuracy.accuracyPercent !== null, rentProcessingAccuracy.accuracyPercent, 100, true, "buildium"
    );

    // Leasing Specialist
    let applicantResponseTimelinessPercent: number | null = null;
    let applicationProcessingTimeHours: number | null = null;
    if (isLeadSimpleConnected()) {
      const applicationsResult = await fetchApplicationProcesses();
      if (applicationsResult.connected && applicationsResult.data) {
        const processingTime = summarizeApplicationProcessingTime(applicationsResult.data, periodStart, asOfDate);
        applicationProcessingTimeHours = processingTime.averageHours;
        await writeSnapshotForEveryDisplayGroup(
          "leasing_specialist", "Application Processing Time", period, periodStart, periodEnd,
          processingTime.averageHours !== null, processingTime.averageHours, 48, false, "lead_simple"
        );
      }

      // Fixed trailing-90-day metric (the vendor's own label reads "(90d)",
      // not tied to the quarter selector) — deliberately NOT scoped to
      // periodStart/periodEnd like the KPIs above.
      const responseWindowStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const responseData = await fetchApplicationsWithTasksForResponseTimeliness(responseWindowStart);
      if (responseData.connected && responseData.data) {
        const responseTimeliness = summarizeApplicantResponseTimeliness(
          responseData.data.processes,
          responseData.data.tasksByProcessId,
          responseWindowStart,
          asOfDate
        );
        applicantResponseTimelinessPercent = responseTimeliness.ratePercent;
        await writeSnapshotForEveryDisplayGroup(
          "leasing_specialist", "Applicant Response Timeliness", period, periodStart, periodEnd,
          responseTimeliness.ratePercent !== null, responseTimeliness.ratePercent, 95, true, "lead_simple"
        );
      }
    }

    const summary = {
      period,
      occupancyRatePercent: occupancy.occupancyRatePercent,
      delinquencyRatePercent: delinquencyRate.ratePercent,
      vendorCompliancePercent: vendorCompliance.compliancePercent,
      nineNineCompliancePercent: nineNine.compliancePercent,
      reconciliationAccuracyPercent: reconciliationAccuracy.accuracyPercent,
      rentProcessingAccuracyPercent: rentProcessingAccuracy.accuracyPercent,
      applicantResponseTimelinessPercent,
      applicationProcessingTimeHours,
    };
    await completeSyncRun(syncLogId, bankAccounts.length + vendors.length + activeLeases.length);
    logInfo("Team Performance KPIs sync completed", { syncLogId, ...summary });
    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failSyncRun(syncLogId, message);
    logError("Team Performance KPIs sync failed", { syncLogId, error: message });
    throw err;
  }
}
