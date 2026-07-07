import { Router } from "express";
import { loadEnv, isRentEngineConnected, isLeadSimpleConnected } from "../config/env.js";
import {
  fetchOutstandingBalances,
  fetchProperties,
  fetchLeasesByStatus,
  fetchActiveLeases,
  fetchAllLeases,
  fetchLeaseTransactions,
  fetchLeaseRecurringTransactions,
  fetchActiveManagedUnits,
  fetchVendors,
  fetchBankAccounts,
  fetchBankAccountReconciliations,
} from "../buildium/client.js";
import { upsertCachedMetric, recordCacheRefreshFailure } from "../db/metricCache.js";
import { startSyncRun, completeSyncRun, failSyncRun, getLastSuccessfulSync } from "../db/syncLog.js";
import { summarizeDelinquency } from "../buildium/delinquency.js";
import {
  summarizeMonthlyCollectionRates,
  resolveLeaseBalancesPerMonth,
  last12Months,
  excludeCurrentInProgressMonth,
  buildDuePerMonth,
  extractDepositDisposition,
  summarizeSecurityDepositWithheld,
  type PastLeaseDeposit,
} from "../kpi/rentCollection.js";
import { syncCallActivityForPeriod } from "../rentengine/callActivitySync.js";
import { resolvePeriod } from "../kpi/period.js";
import { logError, logInfo } from "../lib/logger.js";
import { requireLogin } from "../auth/session.js";
import { syncFinancialHistory } from "../buildium/financialHistorySync.js";
import { summarizeOccupancy, summarizeDelinquencyRate, summarizeRenewalRate, mostRecentRentEffectiveDate } from "../kpi/occupancy.js";
import { renewalRateRows } from "../kpi/leaseRows.js";
import { summarizeDaysOnMarket, summarizeShowingCompletionRate, fetchUnits } from "../rentengine/client.js";
import { getOrFetchLeasingPerformanceForAllUnits } from "../rentengine/leasingPerformanceCache.js";
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
} from "../leadsimple/client.js";
import { periodToSnapshotLabel } from "../kpi/period.js";
import { getKpiDefinitionIdsByName, upsertKpiSnapshot } from "../db/kpiRepository.js";

// requireLogin applied per-route, not via syncRoutes.use() — this router is
// mounted at the app root with no path prefix, and a past real bug here (an
// unscoped .use() on a sibling router accidentally catching /api/sync/status)
// is exactly why every route below gets its own middleware instead.
export const syncRoutes = Router();

// Reports which sources are actually usable right now, and when each one
// last succeeded (never just "last attempted" — see src/db/syncLog.ts).
// Frontend uses this to show "RentEngine: not connected" vs "Buildium: last
// synced 4 minutes ago" instead of guessing.
syncRoutes.get("/api/sync/status", requireLogin, async (_req, res) => {
  try {
    const [buildium, rentEngine, leadSimple] = await Promise.all([
      getLastSuccessfulSync("buildium"),
      getLastSuccessfulSync("rent_engine"),
      getLastSuccessfulSync("lead_simple"),
    ]);
    res.json({
      buildium: { connected: true, lastSyncedAt: buildium?.completedAt ?? null },
      rentEngine: { connected: isRentEngineConnected(), lastSyncedAt: rentEngine?.completedAt ?? null },
      leadSimple: { connected: isLeadSimpleConnected(), lastSyncedAt: leadSimple?.completedAt ?? null },
    });
  } catch (err) {
    logError("GET /api/sync/status failed", { error: String(err) });
    res.status(500).json({ error: "Failed to load sync status." });
  }
});

// Manual "sync now" trigger for the Buildium-backed metric cache tiles.
// Synchronous (awaits the refresh before responding) — the cache refresh
// this covers is small enough (delinquency summary + property count) that
// a background job isn't warranted yet; if that changes, this becomes a
// fire-and-forget with the sync log row as the only way to check progress.
syncRoutes.post("/api/sync/now", requireLogin, async (_req, res) => {
  const syncLogId = await startSyncRun("buildium", "metric_cache_refresh");
  try {
    const [balances, properties] = await Promise.all([fetchOutstandingBalances(), fetchProperties()]);
    const delinquency = summarizeDelinquency(balances);

    await upsertCachedMetric("delinquency_summary", "portfolio", "buildium", delinquency);
    await upsertCachedMetric("property_count", "portfolio", "buildium", { count: properties.length });

    await completeSyncRun(syncLogId, properties.length + balances.length);
    logInfo("Manual sync completed", { syncLogId });
    res.json({ ok: true, syncedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCacheRefreshFailure("delinquency_summary", "portfolio", "buildium", message);
    await failSyncRun(syncLogId, message);
    logError("Manual sync failed", { syncLogId, error: message });
    res.status(502).json({ error: "Sync failed. Last known-good data is still being served.", detail: message });
  }
});

// CONFIRMED LIVE 2026-07-03 against Jason's real Buildium account: the
// rent-collection chart previously computed live on every page load by
// calling fetchLeaseTransactions once per active lease (~230 calls at full
// portfolio size) — this genuinely hit Buildium's rate limit and returned
// real 429s, not a hypothetical risk anymore. This sync endpoint moves that
// same expensive computation OFF the page-load path and into an explicit,
// on-demand refresh that writes its result to dashboard_metric_cache;
// GET /api/dashboard/financials/rent-collection (dashboardRoutes.ts) now
// reads from that cache instead of hitting Buildium directly. Separate
// endpoint (not folded into /api/sync/now above) so a full portfolio sync
// doesn't get slower every time this endpoint is hit — the two caches
// refresh independently, at whatever cadence each one's caller needs.
//
// ============================================================================
// FIXED 2026-07-04 — the 4th bug in this endpoint (prepayment/applied-credit
// reconciliation) was closed via a FIFO cash-application model, replacing
// earliestPaymentPerMonth (kept only for reference, no longer called).
//
// REBUILT 2026-07-07, per Jason directly: "paid by 3rd/10th" was still the
// wrong QUESTION, not just the wrong math — Jason only counts a lease as
// late once the balance still owed exceeds $200 (he's tracked this by hand
// since Aug 2025 and only counts a lease as late once it clears that bar),
// and small remaining balances routinely clear between day 3 and day 10.
// See resolveLeaseBalancesPerMonth + LATE_BALANCE_THRESHOLD in
// src/kpi/rentCollection.ts — same underlying FIFO engine, now capped at a
// point in time (day 3 / day 10) instead of run to full resolution, so it
// reports the balance STILL OWED as of each cutoff rather than a binary
// paid/not-paid. Also confirmed this correctly handles an NSF bounce
// (real case: lease 2066996, 4513 Indies Court) without any special-casing
// — see that function's comment for how. Re-verified live against Jason's
// own manual tracking spreadsheet (not just the vendor site) after this
// landed.
syncRoutes.post("/api/sync/rent-collection", requireLogin, async (_req, res) => {
  const syncLogId = await startSyncRun("buildium", "rent_collection_cache_refresh");
  try {
    // FIXED 2026-07-04, moved into fetchActiveLeases() itself 2026-07-05:
    // found while investigating the paid-by-3rd/10th bug — CONFIRMED LIVE
    // against Jason's real account that 37 of the 240 leases Buildium
    // reports as LeaseStatus="Active" are actually stale/ghost records:
    // CurrentTenants is empty AND LeaseToDate is years in the past (e.g.
    // lease 774300: LeaseFromDate 2015-11-12, LeaseToDate 2018-04-22,
    // CurrentTenants: [], but LeaseStatus still says "Active"). These
    // never get a real rent payment in any recent month because nobody
    // actually lives there anymore — Buildium's LeaseStatus field just
    // never got flipped to "Past" for them. Left in the denominator,
    // these leases can only ever count as "unpaid," dragging every
    // month's paid-by-3rd/10th percentage down regardless of the other
    // fixes here. This filter now lives in fetchActiveLeases()
    // (src/buildium/client.ts) so every dashboard KPI gets it, not just
    // this sync — filtering drops the set from 240 to 203, matching the
    // ~202 genuinely-occupied-unit count the occupancy fix (see
    // src/kpi/occupancy.ts) independently landed on.
    const activeLeases = await fetchActiveLeases();
    // See last12Months/excludeCurrentInProgressMonth/buildDuePerMonth in
    // src/kpi/rentCollection.ts for the other two real bugs fixed here
    // (2026-07-04): the current in-progress month trivially made
    // paidByThird == paidByTenth, and leases were counted as "due" in
    // months before they even started, inflating the denominator and
    // dragging every month's percentage down versus the real vendor
    // numbers.
    const monthsInWindow = excludeCurrentInProgressMonth(last12Months(new Date()), new Date());
    const duePerMonth = buildDuePerMonth(activeLeases, monthsInWindow);

    // Sequential, not Promise.all: the old Promise.all(activeLeases.map(...))
    // fired every lease's transaction fetch at once, which is exactly what
    // triggered the real 429s. buildiumGet's own retry-with-backoff (see
    // src/buildium/client.ts) is a safety net for isolated bursts, but
    // deliberately spacing out ~230 calls in the first place is the actual
    // fix — this endpoint is meant to be called by a scheduled sync, not on
    // every page load, so taking longer here is an acceptable trade.
    const balancesByLease: ReturnType<typeof resolveLeaseBalancesPerMonth>[] = [];
    for (const lease of activeLeases) {
      const transactions = await fetchLeaseTransactions(String(lease.Id));
      balancesByLease.push(resolveLeaseBalancesPerMonth(String(lease.Id), transactions));
    }

    const rentCollection = summarizeMonthlyCollectionRates(duePerMonth, balancesByLease.flat());
    await upsertCachedMetric("rent_collection_12mo", "portfolio", "buildium", rentCollection);

    await completeSyncRun(syncLogId, activeLeases.length);
    logInfo("Rent collection sync completed", { syncLogId, leaseCount: activeLeases.length });
    res.json({ ok: true, syncedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCacheRefreshFailure("rent_collection_12mo", "portfolio", "buildium", message);
    await failSyncRun(syncLogId, message);
    logError("Rent collection sync failed", { syncLogId, error: message });
    res.status(502).json({ error: "Rent collection sync failed. Last known-good data is still being served.", detail: message });
  }
});

// Avg SD Withheld % (Dashboard tab Financials section) — NEW 2026-07-04,
// per Oracle's real-data research. Operates on Past leases with a recent
// move-out date, not Active leases — a fundamentally different population
// than the rest of the Financials section. Sequential per-lease transaction
// fetches, same rate-limit discipline as the rent-collection sync above
// (this endpoint's population is much smaller — recent move-outs only, not
// the whole active portfolio — so this runs quickly in practice).
//
// Window: trailing 12 months of LeaseToDate, matching the same "last 12
// months" convention used elsewhere on this dashboard. If this doesn't land
// close to the vendor's real 57% once compared live, the window is the
// first thing to adjust — Oracle's spec flagged this as unconfirmed against
// the vendor's own population, not the formula.
syncRoutes.post("/api/sync/security-deposit-withheld", requireLogin, async (_req, res) => {
  const syncLogId = await startSyncRun("buildium", "security_deposit_withheld_cache_refresh");
  try {
    const pastLeases = await fetchLeasesByStatus(["Past"]);
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setUTCMonth(twelveMonthsAgo.getUTCMonth() - 12);
    const recentMoveOuts = pastLeases.filter(
      (l) => l.LeaseToDate !== null && new Date(l.LeaseToDate) >= twelveMonthsAgo
    );

    const deposits: PastLeaseDeposit[] = recentMoveOuts.map((l) => ({
      leaseId: String(l.Id),
      securityDeposit: l.AccountDetails?.SecurityDeposit ?? null,
    }));

    // Sequential, not Promise.all — same rate-limit reasoning as the
    // rent-collection sync above, applied here even though this
    // population is smaller.
    const dispositions = [];
    for (const lease of recentMoveOuts) {
      const transactions = await fetchLeaseTransactions(String(lease.Id));
      dispositions.push(extractDepositDisposition(String(lease.Id), transactions));
    }

    const summary = summarizeSecurityDepositWithheld(deposits, dispositions);
    await upsertCachedMetric("security_deposit_withheld", "portfolio", "buildium", summary);

    await completeSyncRun(syncLogId, recentMoveOuts.length);
    logInfo("Security deposit withheld sync completed", { syncLogId, ...summary });
    res.json({ ok: true, syncedAt: new Date().toISOString(), ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCacheRefreshFailure("security_deposit_withheld", "portfolio", "buildium", message);
    await failSyncRun(syncLogId, message);
    logError("Security deposit withheld sync failed", { syncLogId, error: message });
    res
      .status(502)
      .json({ error: "Security deposit withheld sync failed. Last known-good data is still being served.", detail: message });
  }
});

// Renewal Rate (Top of Mind tile + its drill-down). REBUILT 2026-07-07: per
// Jason, the real "renewed" signal lives on each lease's Rent recurring-
// charge schedule (Buildium UI: Tenants > Financials > Rent), not on the
// lease record's own fields — see occupancy.ts's summarizeRenewalRate
// comment for the full derivation and live verification. Checking this
// means one /recurringtransactions call per non-Past lease (~200+), so —
// same reasoning as security-deposit-withheld and rent-collection above —
// this cannot run live on every Dashboard page load; it runs here as an
// on-demand sync and caches {summary, rows} together so the drill-down and
// the tile always agree. Sequential, not Promise.all, for the same
// rate-limit reasons as those other syncs.
syncRoutes.post("/api/sync/renewal-rate", requireLogin, async (_req, res) => {
  const syncLogId = await startSyncRun("buildium", "renewal_rate_cache_refresh");
  try {
    const allLeases = await fetchAllLeases();
    // CONFIRMED LIVE 2026-07-07: a lease that renewed (rent-schedule
    // change) and has SINCE ended is still a real renewal — checking the
    // rent signal only for non-Past leases missed these. So this also
    // covers recently-ended Past leases (LeaseToDate within the last ~400
    // days — a safe superset of the 365-day renewal window plus the
    // 300-day moved-out term floor), not just Active/Future ones.
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
    res.json({ ok: true, syncedAt: new Date().toISOString(), ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCacheRefreshFailure("renewal_rate", "portfolio", "buildium", message);
    await failSyncRun(syncLogId, message);
    logError("Renewal rate sync failed", { syncLogId, error: message });
    res
      .status(502)
      .json({ error: "Renewal rate sync failed. Last known-good data is still being served.", detail: message });
  }
});

// Total Calls / Outbound Texts (Marketing & Showings section). CONFIRMED
// LIVE 2026-07-03: RentEngine's /calls and /messages endpoints require one
// request PER PROSPECT (no bulk/account-wide variant), against a confirmed
// 30 req/min rate limit — this cannot run live on a page-load path (see
// src/rentengine/callActivitySync.ts for the full investigation). This
// endpoint runs that scoped, rate-limit-respecting sync for THIS MONTH's
// prospects and writes the result to dashboard_metric_cache; the
// corresponding GET route in rentEngineRoutes.ts (once wired) reads from
// that cache instead of ever calling /calls or /messages directly.
//
// Deliberately scoped to "this month" only, not a longer window — with
// ~4.2s between each prospect's paired calls+messages fetch, a month with
// even 50 new prospects takes ~3.5 minutes to sync; running this for
// every month in a 12-month window in one request would take over 40
// minutes and is exactly the kind of long-running, rate-limited job that
// belongs in a real scheduled background job (not built yet), not
// something to make bigger on the request/response path just because the
// current 1-month scope is quick enough to call synchronously today.
syncRoutes.post("/api/sync/call-activity", requireLogin, async (_req, res) => {
  if (!isRentEngineConnected()) {
    res.status(409).json({ error: "RentEngine is not connected." });
    return;
  }
  const env = loadEnv();
  if (!env.RENTENGINE_ACCOUNT_ID) {
    res.status(409).json({ error: "RENTENGINE_ACCOUNT_ID is not configured." });
    return;
  }

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
    res.json({ ok: true, syncedAt: new Date().toISOString(), ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCacheRefreshFailure("call_activity_this_month", "portfolio", "rent_engine", message);
    await failSyncRun(syncLogId, message);
    logError("RentEngine call activity sync failed", { syncLogId, error: message });
    res.status(502).json({ error: "Call activity sync failed. Last known-good data is still being served.", detail: message });
  }
});

// CEO View Gross Income / Net Income / Revenue-per-Unit history
// (dashboard_financial_history, Neo's migration 0008). CONFIRMED LIVE
// 2026-07-05 against Jason's real Buildium account and real CEO View
// numbers — see src/kpi/financialSummary.ts and
// src/buildium/client.ts's fetchGeneralLedgerTotals for the confirmed
// formula/endpoint. This can be a genuinely slow one-time backfill (one
// Buildium call pair per calendar month back to 2018-01), so it's a
// separate on-demand sync endpoint, same pattern as rent-collection/
// security-deposit-withheld above — NOT run on every /api/sync/now or on
// every CEO View page load. Safe to call repeatedly: syncFinancialHistory
// only re-fetches months not already cached, plus the always-live current
// month, so a second call after the first full backfill completes in a
// few seconds instead of minutes.
syncRoutes.post("/api/sync/financial-history", requireLogin, async (_req, res) => {
  const syncLogId = await startSyncRun("buildium", "financial_history_sync");
  try {
    const result = await syncFinancialHistory();
    await completeSyncRun(syncLogId, result.monthsWritten);
    logInfo("Financial history sync completed", { syncLogId, ...result });
    res.json({ ok: true, syncedAt: new Date().toISOString(), ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failSyncRun(syncLogId, message);
    logError("Financial history sync failed", { syncLogId, error: message });
    res.status(502).json({ error: "Financial history sync failed.", detail: message });
  }
});

// Team Performance / CEO View KPI snapshots — computes real values for
// every KPI confirmed live 2026-07-05 (Portfolio Manager: Occupancy, Days
// on Market, Delinquency Rate; Bookkeeper: all 4) and writes them into
// dashboard_kpi_snapshots for the current quarter. Deliberately does NOT
// touch Lease Renewal Rate (scoping question still open with Jason — see
// src/leadsimple/client.ts's summarizeLeaseRenewalRate comment) — its KPI
// DEFINITION row exists (migration 0009) so the role's dollar-per-KPI math
// stays correct, but no snapshot is written for it, which the existing
// scoring engine already treats as "no data yet" (same tested pattern as
// Bookkeeper's Reconciliation Accuracy before this migration).
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

syncRoutes.post("/api/sync/team-performance-kpis", requireLogin, async (_req, res) => {
  const syncLogId = await startSyncRun("buildium", "team_performance_kpis_sync");
  try {
    const now = new Date();
    const period = periodToSnapshotLabel("this_quarter", now);
    const quarterStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), quarterStartMonth, 1)).toISOString().slice(0, 10);
    // Stored on the snapshot row as the quarter's real calendar end — but
    // NEVER passed as the "to" bound into a KPI calculation itself. Same
    // future-dates bug already fixed elsewhere today (This Month/Quarter/
    // Year reaching past today): summarizeReconciliationAccuracy's
    // "completed months in range" check only looks at whether a month's
    // calendar end falls inside [from, to] — it doesn't independently know
    // today's real date, so passing the quarter's true end (up to 3 months
    // in the future) would make it count August/September as "completed"
    // days after the quarter merely started. asOfDate clamps every KPI
    // calculation's "to" bound to today; periodEnd is kept separately, for
    // storage only.
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), quarterStartMonth + 3, 0)).toISOString().slice(0, 10);
    const asOfDate = now.toISOString().slice(0, 10);
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const monthEnd = now.toISOString().slice(0, 10);

    // Portfolio Manager
    const units = await fetchActiveManagedUnits();
    const activeLeases = await fetchActiveLeases();
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
    // own label reads "(12 mo)"), scoped by each process's created_at —
    // CONFIRMED LIVE 2026-07-06 by manually counting the vendor's own real
    // drill-down data (73 renewed / 118 decided = 61.9%, exact match).
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

        // Portfolio Assistant — KPI definition not seeded yet (waiting on
        // the role's other 2 KPIs so the $750/3-way split is correct from
        // the start), but the calculation itself is confirmed live
        // 2026-07-06 against the vendor's own drill-down (28/47 = 59.6%
        // for June). writeSnapshotForEveryDisplayGroup is a no-op today
        // since getKpiDefinitionIdsByName finds no matching definition —
        // this starts writing real snapshots the moment the migration
        // lands, no code change needed then.
        const units = await fetchUnits();
        if (units.connected && units.data) {
          const showingCompletion = summarizeShowingCompletionRate(leasingPerf.rows, units.data);
          await writeSnapshotForEveryDisplayGroup(
            "portfolio_assistant", "Showing Completion Rate", period, periodStart, periodEnd,
            showingCompletion.ratePercent !== null, showingCompletion.ratePercent, 95, true, "rent_engine"
          );
        }
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

      // Applicant Response Timeliness is a fixed trailing-90-day metric
      // (the vendor's own label reads "(90d)", not tied to the quarter
      // selector) — deliberately NOT scoped to periodStart/periodEnd like
      // the KPIs above.
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
    res.json({ ok: true, syncedAt: new Date().toISOString(), ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failSyncRun(syncLogId, message);
    logError("Team Performance KPIs sync failed", { syncLogId, error: message });
    res.status(502).json({ error: "Team Performance KPIs sync failed.", detail: message });
  }
});

