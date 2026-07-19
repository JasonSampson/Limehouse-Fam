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
  fetchGlAccountsById,
  fetchOnboardingFeeDate,
} from "../buildium/client.js";
import { upsertCachedMetric, recordCacheRefreshFailure } from "../db/metricCache.js";
import { startSyncRun, completeSyncRun, failSyncRun, getLastSuccessfulSync } from "../db/syncLog.js";
import { summarizeDelinquency } from "../buildium/delinquency.js";
import {
  summarizeMonthlyCollectionRates,
  resolveLeaseBalancesPerMonth,
  monthsSinceYearsAgo,
  buildDuePerMonth,
  extractSecurityDepositWithheld,
  summarizeSecurityDepositWithheld,
  securityDepositMoveOutWindow,
} from "../kpi/rentCollection.js";
import { securityDepositWithheldRows } from "../kpi/leaseRows.js";
import { syncCallActivityForPeriod } from "../rentengine/callActivitySync.js";
import { logError, logInfo } from "../lib/logger.js";
import { requireLogin } from "../auth/session.js";
import { syncFinancialHistory } from "../buildium/financialHistorySync.js";
import { fetchLeaseRenewalProcesses } from "../leadsimple/client.js";
import { findTerminatingCandidates, matchCandidatesToActiveProperties, isStillExcluded } from "../kpi/terminatedProperties.js";
import {
  refreshRentCollectionCache,
  refreshSecurityDepositWithheldCache,
  refreshRenewalRateCache,
  refreshCallActivityCache,
  runTeamPerformanceKpisSync,
} from "../jobs/cacheRefreshJobs.js";

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
    // FIXED [today]: was caching properties.length raw (323, every
    // property Buildium has ever recorded for this account), not the ~197
    // actually-active count — same unfiltered-fetchProperties() pattern
    // fixed on the /api/dashboard/properties route above. This
    // "property_count" cached value currently has no reader anywhere else
    // in the codebase (confirmed by search), so it wasn't user-visible,
    // but fixing it here too so it's correct if/when something reads it.
    const activePropertyCount = properties.filter((p) => p.IsActive === true).length;

    await upsertCachedMetric("delinquency_summary", "portfolio", "buildium", delinquency);
    await upsertCachedMetric("property_count", "portfolio", "buildium", { count: activePropertyCount });

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
//
// WIDENED 2026-07-09, per Jason directly: the new "Rent Collected by Month
// End" side panels next to the existing chart need a same-calendar-month
// comparison a full year back, plus several complete years for a by-year
// rollup — the existing chart's trailing-12-month window doesn't reach far
// enough back for either. Switched from last12Months to
// monthsSinceYearsAgo(asOf, 2) (back to January of two years ago), which
// costs nothing extra in Buildium API calls — fetchLeaseTransactions
// already pulls each lease's FULL transaction history with no date
// filtering, so widening the window just means extracting more months from
// data already being fetched, not fetching more data. The existing 12-month
// chart is unaffected: it slices the last 12 COMPLETE months off this wider
// result on the frontend (see renderRentCollectionChart in dashboard.js)
// rather than being fed a separately-scoped dataset. Per Jason's own
// scoping: this still only covers CURRENTLY-active leases, same as before —
// a tenant who moved out doesn't drag down an earlier year's numbers, but
// it also means an early year's total can undercount the true historical
// portfolio (leases that have since turned over are invisible for every
// month, not just the ones after they left) — an accepted, deliberate
// limitation, not a bug.
//
// STOPPED EXCLUDING THE CURRENT MONTH 2026-07-09, per Jason directly: he
// asked why "Rent By 10th" was showing a month-old figure when today's own
// running total was sitting right there and more current. The answer is
// that this endpoint used to drop the in-progress month entirely — but on
// closer look that exclusion was solving a DIFFERENT, narrower problem (a
// 2026-07-04 fix: showing paidByThird == paidByTenth for an in-progress
// month looked like a bug, since day 10 hadn't happened yet to tell them
// apart). The underlying MATH was never wrong: outstandingBalanceAsOf (see
// rentCollection.ts) filters credits by `date <= cutoff`, and Buildium
// simply has no transactions dated after today — so asking for "balance as
// of the 10th" while today is only the 9th naturally returns "balance as of
// today" anyway, automatically, with no special-casing. That means
// paidByThirdPercent/paidByTenthPercent/paidByMonthEndPercent for the
// current month are ALREADY correct at every point in the month: a live
// rolling figure before each cutoff passes, and the true final figure once
// it does. Keeping the month out of the window was throwing away a
// genuinely-correct, more-current number to avoid a labeling problem — the
// frontend now solves that labeling problem directly with a "(so far)"
// qualifier instead (see renderFinancials in dashboard.js), which also
// retired the separate resolveCurrentMonthBalance/summarizeCurrentMonthRolling
// functions this session had briefly added — same data, one path now.
// FIXED 2026-07-04, moved into fetchActiveLeases() itself 2026-07-05: found
// while investigating the paid-by-3rd/10th bug — CONFIRMED LIVE against
// Jason's real account that 37 of the 240 leases Buildium reports as
// LeaseStatus="Active" are actually stale/ghost records: CurrentTenants is
// empty AND LeaseToDate is years in the past. That filter now lives in
// fetchActiveLeases() (src/buildium/client.ts) so every dashboard KPI gets
// it. See last12Months/buildDuePerMonth in src/kpi/rentCollection.ts for
// the other real bug fixed here (2026-07-04): leases counted as "due" in
// months before they even started.
//
// REFACTORED 2026-07-18: the actual work moved to refreshRentCollectionCache
// in src/jobs/cacheRefreshJobs.ts so the automatic scheduler (scheduler.ts)
// and this manual "sync now" button call the exact same implementation —
// this route is now just the HTTP wrapper around it.
syncRoutes.post("/api/sync/rent-collection", requireLogin, async (_req, res) => {
  try {
    await refreshRentCollectionCache();
    res.json({ ok: true, syncedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Rent collection sync failed. Last known-good data is still being served.", detail: message });
  }
});

// Avg SD Withheld / Avg SD Withheld % (Dashboard tab Financials section) —
// REBUILT 2026-07-10, per Jason directly, matching the vendor's own
// real methodology (read from their live drill-down note, then confirmed
// against real Buildium data) — see the full derivation in
// rentCollection.ts's comment above summarizeSecurityDepositWithheld.
// Operates on Past leases with a recent move-out date, not Active leases —
// a fundamentally different population than the rest of the Financials
// section. Only fetches transactions for leases whose move-out already
// falls in the real window (13 months ago through 30 days ago), not every
// Past lease ever, keeping this fast even as the window slides forward.
// REFACTORED 2026-07-18: actual work moved to
// refreshSecurityDepositWithheldCache in src/jobs/cacheRefreshJobs.ts — see
// the rent-collection route above for why.
syncRoutes.post("/api/sync/security-deposit-withheld", requireLogin, async (_req, res) => {
  try {
    await refreshSecurityDepositWithheldCache();
    res.json({ ok: true, syncedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
// REFACTORED 2026-07-18: actual work moved to refreshRenewalRateCache in
// src/jobs/cacheRefreshJobs.ts — see the rent-collection route above for
// why.
syncRoutes.post("/api/sync/renewal-rate", requireLogin, async (_req, res) => {
  try {
    await refreshRenewalRateCache();
    res.json({ ok: true, syncedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res
      .status(502)
      .json({ error: "Renewal rate sync failed. Last known-good data is still being served.", detail: message });
  }
});

// Terminated Properties — ADDED 2026-07-10, per Jason directly. See
// src/kpi/terminatedProperties.ts for the full derivation (real examples:
// 3400 Landstown Court, 300 Garrison Place). Cross-references LeadSimple's
// Lease Renewal processes against Buildium leases and each CANDIDATE
// property's own GL ledger (for an Owner Onboarding Fee transaction) —
// both only affordable because this is scoped to the small set of
// candidates LeadSimple identifies first (one Lease Renewal process fetch,
// then per-property checks only for the handful still flagged), not run
// across the whole 234-property portfolio.
syncRoutes.post("/api/sync/terminated-properties", requireLogin, async (_req, res) => {
  if (!isLeadSimpleConnected()) {
    res.status(409).json({ error: "LeadSimple is not connected." });
    return;
  }
  const syncLogId = await startSyncRun("buildium", "terminated_properties_cache_refresh");
  try {
    const [processResult, allProperties, allLeases, glAccountsById] = await Promise.all([
      fetchLeaseRenewalProcesses(),
      fetchProperties(),
      fetchAllLeases(),
      fetchGlAccountsById(),
    ]);
    if (!processResult.connected || !processResult.data) {
      throw new Error(processResult.error ?? "LeadSimple Lease Renewal processes unavailable");
    }

    const candidates = findTerminatingCandidates(processResult.data);
    const activeProperties = allProperties.filter((p) => p.IsActive === true);
    const matched = matchCandidatesToActiveProperties(candidates, activeProperties);

    const glAccountIds = [...glAccountsById.keys()];
    const now = new Date();
    const leasesByPropertyId = new Map<number, typeof allLeases>();
    for (const l of allLeases) {
      const bucket = leasesByPropertyId.get(l.PropertyId);
      if (bucket) bucket.push(l);
      else leasesByPropertyId.set(l.PropertyId, [l]);
    }

    // Sequential, not Promise.all — same rate-limit reasoning as the other
    // per-property GL/transaction syncs in this file. Only runs for the
    // small candidate set (typically well under 20 properties), not the
    // whole portfolio.
    const stillExcluded: typeof matched = [];
    for (const candidate of matched) {
      const leasesForProperty = leasesByPropertyId.get(Number(candidate.propertyId)) ?? [];
      const onboardingFeeDate = await fetchOnboardingFeeDate(
        Number(candidate.propertyId),
        glAccountIds,
        candidate.terminatedAt.slice(0, 10),
        now
      );
      if (isStillExcluded(candidate.terminatedAt, leasesForProperty, onboardingFeeDate)) {
        stillExcluded.push(candidate);
      }
    }

    await upsertCachedMetric("terminated_properties", "portfolio", "buildium", { excluded: stillExcluded });

    await completeSyncRun(syncLogId, matched.length);
    logInfo("Terminated properties sync completed", {
      syncLogId,
      candidateCount: matched.length,
      excludedCount: stillExcluded.length,
    });
    res.json({
      ok: true,
      syncedAt: new Date().toISOString(),
      candidateCount: matched.length,
      excludedCount: stillExcluded.length,
      excluded: stillExcluded,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCacheRefreshFailure("terminated_properties", "portfolio", "buildium", message);
    await failSyncRun(syncLogId, message);
    logError("Terminated properties sync failed", { syncLogId, error: message });
    res
      .status(502)
      .json({ error: "Terminated properties sync failed. Last known-good data is still being served.", detail: message });
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
// REFACTORED 2026-07-18: actual work moved to refreshCallActivityCache in
// src/jobs/cacheRefreshJobs.ts — see the rent-collection route above for
// why. That function silently no-ops (rather than erroring) if RentEngine
// isn't connected or RENTENGINE_ACCOUNT_ID isn't configured, since the
// scheduler calls it unconditionally on a timer; this route still checks
// both up front so a manual click gets an honest, specific 409 instead of
// a silent no-op "success."
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

  try {
    await refreshCallActivityCache();
    res.json({ ok: true, syncedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
//
// EXTRACTED 2026-07-19, per Jason directly, into
// src/jobs/cacheRefreshJobs.ts's runTeamPerformanceKpisSync() — same
// "one implementation, called from the manual route and the automatic
// scheduler" pattern already used for the other jobs in that file. This
// route is now just the thin HTTP wrapper.
syncRoutes.post("/api/sync/team-performance-kpis", requireLogin, async (_req, res) => {
  try {
    const summary = await runTeamPerformanceKpisSync();
    res.json({ ok: true, syncedAt: new Date().toISOString(), ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Team Performance KPIs sync failed.", detail: message });
  }
});

