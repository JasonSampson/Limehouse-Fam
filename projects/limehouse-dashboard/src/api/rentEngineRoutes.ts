import { Router } from "express";
import { z } from "zod";
import {
  fetchProspects,
  fetchUnits,
  summarizeProspectsBySource,
  summarizeLeasingFunnel,
  leasingFunnelStageRows,
  summarizeUnitsOnMarket,
  isUnitOnMarket,
  summarizeDaysOnMarket,
  summarizeMarketingActivityFromReporting,
  summarizeShowingCompletionRate,
  showingCompletionRateExplainRows,
  fetchMarketingSourcesReport,
  fetchShowingsReport,
  isShowingCompleted,
  isShowingSelfGuided,
} from "../rentengine/client.js";
import { getOrFetchLeasingPerformanceForAllUnits } from "../rentengine/leasingPerformanceCache.js";
import { resolvePeriod, type PeriodKey } from "../kpi/period.js";
import { logError, logWarn } from "../lib/logger.js";
import { requireLogin } from "../auth/session.js";

// requireLogin applied per-route, not via rentEngineRoutes.use() — same
// app-root-mounting reasoning as dashboardRoutes.ts.
export const rentEngineRoutes = Router();

const periodQuerySchema = z
  .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year"])
  .default("this_month");

function resolveDateRangeFromQuery(periodRaw: unknown): { from: string; to: string } {
  const parsed = periodQuerySchema.safeParse(periodRaw);
  const period: PeriodKey = parsed.success ? parsed.data : "this_month";
  const range = resolvePeriod(period);
  return { from: `${range.from}T00:00:00Z`, to: `${range.to}T23:59:59Z` };
}

// Marketing & Showings section: New Prospects by Source. FLOW-classified
// (respects the period selector) — counts prospects CREATED within the
// selected period, normalized per src/rentengine/client.ts's confirmed
// live source-duplicate findings (Rent.com/rent.com/rent, etc.).
//
// RentEngine's own account history only goes back to 2026-02-11
// (confirmed live — earliest prospect record), so selecting a period
// before that will just come back empty/small, not wrong; this route
// does not claim any history it doesn't have.
// CORRECTED 2026-07-04: switched from manually normalizing raw /prospects
// source strings (Rent.com/rent.com/rent duplicates) to RentEngine's own
// /reporting/marketing-sources endpoint, confirmed live — it returns a
// pre-normalized source_display field directly, so no client-side
// normalization guesswork is needed anymore. Falls back to the old
// raw-prospect approach if the reporting endpoint errors, rather than
// breaking this tile entirely.
rentEngineRoutes.get("/api/rentengine/prospects-by-source", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  const reportResult = await fetchMarketingSourcesReport(from, to);

  if (!reportResult.connected) {
    res.json({ connected: false, sources: [] });
    return;
  }
  if (reportResult.data) {
    const sources = reportResult.data
      .map((row) => ({ source: row.source_display ?? row.source_key ?? "Unknown", count: row.leads }))
      .sort((a, b) => b.count - a.count);
    const totalProspects = sources.reduce((sum, s) => sum + s.count, 0);
    res.json({ connected: true, sources, totalProspects });
    return;
  }

  // Fallback: the reporting endpoint failed, try the older raw-prospect
  // approach rather than showing nothing.
  logWarn("Marketing sources report failed, falling back to raw prospect grouping", { error: reportResult.error });
  const result = await fetchProspects(from, to);
  if (result.error || !result.data) {
    logError("GET /api/rentengine/prospects-by-source failed", { error: result.error });
    res.status(502).json({ error: "Failed to load prospect data from RentEngine.", detail: result.error });
    return;
  }
  res.json({ connected: true, sources: summarizeProspectsBySource(result.data), totalProspects: result.data.length });
});

// Marketing & Showings section: New Prospects, Showings Completed
// (derived from Leasing Funnel status buckets), plus the Leasing Funnel
// tile itself. FLOW-classified.
//
// NOT AVAILABLE, flagged honestly rather than faked: RentEngine's API has
// no history/trend endpoint and no data before Feb 2026 (confirmed live),
// so "Last 12 Months" cannot be a real trailing-12-months view yet no
// matter what period is requested — this route always computes over
// whatever period was actually requested and reports it back plainly
// (`requestedFrom`/`requestedTo`) rather than silently substituting a
// shorter window while still labeling it "12 months."
rentEngineRoutes.get("/api/rentengine/leasing-funnel", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  const result = await fetchProspects(from, to);

  if (!result.connected) {
    res.json({ connected: false, funnel: null });
    return;
  }
  if (result.error || !result.data) {
    logError("GET /api/rentengine/leasing-funnel failed", { error: result.error });
    res.status(502).json({ error: "Failed to load leasing funnel data from RentEngine.", detail: result.error });
    return;
  }

  res.json({
    connected: true,
    requestedFrom: from,
    requestedTo: to,
    funnel: summarizeLeasingFunnel(result.data),
  });
});

const leasingFunnelStageSchema = z.enum(["prospects", "showingsScheduled", "showingsCompleted", "applications", "moveIns"]);

// Leasing Funnel drill-down — ADDED 2026-07-13, per Jason directly, to
// match the vendor's own chart (clicking a stage bar opens the real
// prospects behind that count). One route for all 5 stages, reusing the
// same fetchProspects call the summary above already makes — no extra
// RentEngine calls. "prospects" (no filter) is included here too, even
// though it duplicates what /api/rentengine/prospects above already
// returns, so all 5 Leasing Funnel bars go through one consistent
// implementation instead of the first bar being a special case.
rentEngineRoutes.get("/api/rentengine/leasing-funnel/stage", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  const stageParsed = leasingFunnelStageSchema.safeParse(req.query.stage);
  if (!stageParsed.success) {
    res.status(400).json({ error: "Invalid or missing stage query param." });
    return;
  }
  const result = await fetchProspects(from, to);
  if (!result.connected) {
    res.json({ connected: false, prospects: [] });
    return;
  }
  if (result.error || !result.data) {
    logError("GET /api/rentengine/leasing-funnel/stage failed", { error: result.error });
    res.status(502).json({ error: "Failed to load prospect data from RentEngine.", detail: result.error });
    return;
  }
  const rows = leasingFunnelStageRows(result.data, stageParsed.data);
  res.json({
    connected: true,
    prospects: rows.map((p) => ({ name: p.name, source: p.source, status: p.status, createdAt: p.created_at })),
  });
});

// Marketing & Showings section: Units on Market.
// STRUCTURAL (as-of-today, not period-dependent) — RentEngine's /units
// endpoint has no date filter and represents current listing state.
//
// CONFIRMED LIVE 2026-07-03: this account's /units endpoint returns only
// 61 total unit records — a subset of units RentEngine has ever been
// asked to market, NOT the full ~230-unit Buildium portfolio. totalUnitsTracked
// is returned alongside unitsOnMarket so the frontend/Jason can see this
// is scoped to RentEngine's own tracked set, not implied to be
// portfolio-wide. See src/rentengine/client.ts summarizeUnitsOnMarket for
// the Available+occupied judgment call this number depends on.
//
// Completion Rate now lives on its own route, GET
// /api/rentengine/completion-rate — see that route's comment below for why
// it was split out of marketing-activity.
rentEngineRoutes.get("/api/rentengine/units-on-market", requireLogin, async (_req, res) => {
  const result = await fetchUnits();

  if (!result.connected) {
    res.json({ connected: false, unitsOnMarket: null, totalUnitsTracked: null });
    return;
  }
  if (result.error || !result.data) {
    logError("GET /api/rentengine/units-on-market failed", { error: result.error });
    res.status(502).json({ error: "Failed to load unit data from RentEngine.", detail: result.error });
    return;
  }

  res.json({
    connected: true,
    ...summarizeUnitsOnMarket(result.data),
  });
});

// New Prospects, Total Calls, Outbound Texts (Marketing & Showings
// section) — Total Calls/Outbound Texts are CACHE-BACKED, same pattern as
// /api/dashboard/financials/rent-collection: the underlying data requires
// one RentEngine API call per prospect (confirmed live, see
// src/rentengine/callActivitySync.ts), which cannot run on a page-load
// path without risking the rate limit. This route reads whatever
// POST /api/sync/call-activity (syncRoutes.ts) last wrote to
// dashboard_metric_cache, and returns an honest 503 telling the caller to
// trigger that sync first if it has never run.
//
// New Prospects itself does NOT require the leasing-performance cache —
// it's just a prospect count for the period, same live call
// prospects-by-source already makes — so it's fetched fresh here in
// parallel rather than waiting on that cache.
// CORRECTED 2026-07-19, per Jason directly: this used to be sourced from
// the per-unit reporting field summed across every tracked unit
// (summary.newProspects below), which CONFIRMED LIVE against two of
// Jason's own vendor screenshots undercounts — the vendor's real "New
// Prospects" is a plain count of prospect records, matching
// New Prospects by Source's total and the Leasing Funnel's own Prospects
// count exactly on both screenshots checked. See the comment on
// summarizeMarketingActivityFromReporting in client.ts for the fuller
// story — this route now counts real prospect records directly instead.
// CORRECTED 2026-07-04: Total Calls/Outbound Texts used to depend on
// callActivitySync.ts's N+1-per-prospect background job. RentEngine's real
// Reporting API aggregates total_calls/outbound_texts per unit directly
// (GET /reporting/leasing-performance/units/{unitId}), so this now sums
// that across all tracked units instead — same cache-backed pattern (~61
// calls, not run live), but sourced from RentEngine's own aggregation
// rather than ours. callActivitySync.ts / POST /api/sync/call-activity are
// left in place (not deleted) since Tron's frontend contract may still
// reference the old cache key — safe to retire once confirmed unused.
//
// showingsCompleted CORRECTED 2026-07-19, per Jason directly — TWICE in
// one day. First pass switched this to summarizeLeasingFunnel's
// prospect-status-bucket count (87), based on two older vendor
// screenshots. A fresh, live vendor screenshot (same day, same period)
// then showed the real number is 76, sourced — per the vendor's own
// drill-down note — from a plain count of real /reporting/showings rows
// whose status is "Showing Complete." That fresh screenshot also showed
// 76 on the vendor's OWN Leasing Funnel "Showings completed" stage, so
// their funnel isn't using a prospect-status bucket either — it's built
// off this same showings report. This route now fetches that report
// directly (isShowingCompleted from client.ts, same filter the
// /api/rentengine/showings drill-down route already used) instead of
// either the blanket per-unit sum or the funnel-bucket count.
rentEngineRoutes.get("/api/rentengine/marketing-activity", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  try {
    const [shared, prospectsResult, showingsResult] = await Promise.all([
      getOrFetchLeasingPerformanceForAllUnits(from, to),
      fetchProspects(from, to),
      fetchShowingsReport(from, to),
    ]);
    if (!shared.connected) {
      res.json({
        connected: false,
        newProspects: null,
        showingsScheduled: null,
        showingsCompleted: null,
        totalCalls: null,
        outboundTexts: null,
      });
      return;
    }
    if (shared.error || !shared.rows) {
      logError("GET /api/rentengine/marketing-activity failed", { error: shared.error });
      res.status(502).json({ error: "Failed to load leasing-performance data from RentEngine.", detail: shared.error });
      return;
    }
    if (prospectsResult.error || !prospectsResult.data) {
      logError("GET /api/rentengine/marketing-activity failed", { error: prospectsResult.error });
      res.status(502).json({ error: "Failed to load prospect data from RentEngine.", detail: prospectsResult.error });
      return;
    }
    if (showingsResult.error || !showingsResult.data) {
      logError("GET /api/rentengine/marketing-activity failed", { error: showingsResult.error });
      res.status(502).json({ error: "Failed to load showings data from RentEngine.", detail: showingsResult.error });
      return;
    }
    const summary = summarizeMarketingActivityFromReporting(shared.rows);
    const showingsCompleted = showingsResult.data.filter((s) => isShowingCompleted(s.status)).length;
    res.json({
      connected: true,
      newProspects: prospectsResult.data.length,
      showingsScheduled: summary.showingsScheduled,
      showingsCompleted,
      totalCalls: summary.totalCalls,
      outboundTexts: summary.outboundTexts,
      callActivitySynced: true,
      cached: shared.cached,
      cachedAt: shared.cachedAt,
      stale: shared.stale,
    });
  } catch (err) {
    logError("GET /api/rentengine/marketing-activity failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load marketing activity data from RentEngine." });
  }
});

// Avg Days on Market / Median DOM — CORRECTED 2026-07-04. The
// "genuinely not available" conclusion below was wrong: it was true for
// /units (no days_on_market field there), but Jason found RentEngine's
// real docs (docs.rentengine.io/openapi) revealing a separate Reporting
// API with GET /reporting/leasing-performance/units/{unitId}, which
// returns days_on_market directly, confirmed live. Cache-backed (same
// pattern as property-health/rent-collection) since computing this live
// means ~61 RentEngine calls, one per tracked unit.
rentEngineRoutes.get("/api/rentengine/days-on-market", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  try {
    const shared = await getOrFetchLeasingPerformanceForAllUnits(from, to);
    if (!shared.connected) {
      res.json({ connected: false, avgDaysOnMarket: null, medianDaysOnMarket: null });
      return;
    }
    if (shared.error || !shared.rows) {
      logError("GET /api/rentengine/days-on-market failed", { error: shared.error });
      res.status(502).json({ error: "Failed to load leasing-performance data from RentEngine.", detail: shared.error });
      return;
    }
    const summary = summarizeDaysOnMarket(shared.rows);
    res.json({
      connected: true,
      available: true,
      ...summary,
      cached: shared.cached,
      cachedAt: shared.cachedAt,
      stale: shared.stale,
    });
  } catch (err) {
    logError("GET /api/rentengine/days-on-market failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load days-on-market data from RentEngine." });
  }
});

// Completion Rate — SPLIT OFF marketing-activity 2026-07-13, per Jason
// directly. The blanket version (showings summed across every tracked
// unit, Leased/On Hold/Incomplete included) doesn't match the vendor's
// real Completion Rate tile — CONFIRMED against the vendor's own
// drill-down that they scope to units actually available for showing
// (status not Leased/On Hold/Incomplete). Reuses
// summarizeShowingCompletionRate, which already computes exactly this and
// was already vendor-confirmed for the Team Performance "Portfolio
// Assistant KPI" build a day earlier — never wired back to this Dashboard
// tile until now. Same shared cache as the other RentEngine tiles.
rentEngineRoutes.get("/api/rentengine/completion-rate", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  try {
    const [shared, unitsResult] = await Promise.all([getOrFetchLeasingPerformanceForAllUnits(from, to), fetchUnits()]);
    if (!shared.connected || !unitsResult.connected) {
      res.json({ connected: false, showingsScheduled: null, showingsCompleted: null, ratePercent: null });
      return;
    }
    if (shared.error || !shared.rows) {
      logError("GET /api/rentengine/completion-rate failed", { error: shared.error });
      res.status(502).json({ error: "Failed to load leasing-performance data from RentEngine.", detail: shared.error });
      return;
    }
    if (unitsResult.error || !unitsResult.data) {
      logError("GET /api/rentengine/completion-rate failed", { error: unitsResult.error });
      res.status(502).json({ error: "Failed to load unit data from RentEngine.", detail: unitsResult.error });
      return;
    }
    const summary = summarizeShowingCompletionRate(shared.rows, unitsResult.data);
    res.json({
      connected: true,
      showingsScheduled: summary.showingsScheduled,
      showingsCompleted: summary.showingsCompleted,
      ratePercent: summary.ratePercent,
      cached: shared.cached,
      cachedAt: shared.cachedAt,
      stale: shared.stale,
    });
  } catch (err) {
    logError("GET /api/rentengine/completion-rate failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load completion rate data from RentEngine." });
  }
});

// Completion Rate drill-down — same on-market-for-showing scoping as the
// summary above, via showingCompletionRateExplainRows, joined with
// address/status from fetchUnits() (same join pattern as the Units on
// Market / Days on Market drill-downs). Matches the vendor's exact
// columns: Address, Status, Scheduled, Completed, Rate.
rentEngineRoutes.get("/api/rentengine/completion-rate/units", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  try {
    const [shared, unitsResult] = await Promise.all([getOrFetchLeasingPerformanceForAllUnits(from, to), fetchUnits()]);
    if (!shared.connected || !unitsResult.connected) {
      res.json({ connected: false, units: [] });
      return;
    }
    if (shared.error || !shared.rows) {
      logError("GET /api/rentengine/completion-rate/units failed", { error: shared.error });
      res.status(502).json({ error: "Failed to load leasing-performance data from RentEngine.", detail: shared.error });
      return;
    }
    if (unitsResult.error || !unitsResult.data) {
      logError("GET /api/rentengine/completion-rate/units failed", { error: unitsResult.error });
      res.status(502).json({ error: "Failed to load unit data from RentEngine.", detail: unitsResult.error });
      return;
    }
    const unitsById = new Map(unitsResult.data.map((u) => [u.id, u]));
    const rows = showingCompletionRateExplainRows(shared.rows, unitsResult.data);
    res.json({
      connected: true,
      units: rows.map((r) => {
        const unit = unitsById.get(r.unitId);
        return {
          unitId: r.unitId,
          address: unit?.address?.formatted_address ?? null,
          status: unit?.status ?? null,
          showingsScheduled: r.showingsScheduled,
          showingsCompleted: r.showingsCompleted,
          ratePercent: r.showingsScheduled > 0 ? Math.round((r.showingsCompleted / r.showingsScheduled) * 1000) / 10 : null,
        };
      }),
    });
  } catch (err) {
    logError("GET /api/rentengine/completion-rate/units failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load completion rate data from RentEngine." });
  }
});

// ============================================================================
// Drill-downs added 2026-07-04, per the same batch as dashboardRoutes.ts's
// new drill-downs. Jason approved this batch directly.
// ============================================================================

// New Prospects drill-down — reuses the same fetchProspects call
// prospects-by-source already makes, just returns the raw rows instead of
// grouping by source.
rentEngineRoutes.get("/api/rentengine/prospects", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  const result = await fetchProspects(from, to);
  if (!result.connected) {
    res.json({ connected: false, prospects: [] });
    return;
  }
  if (result.error || !result.data) {
    logError("GET /api/rentengine/prospects failed", { error: result.error });
    res.status(502).json({ error: "Failed to load prospect data from RentEngine.", detail: result.error });
    return;
  }
  res.json({
    connected: true,
    // name — ADDED 2026-07-13, matching the vendor's own drill-down Name
    // column (see leasing-funnel/stage below, added the same day).
    prospects: result.data.map((p) => ({
      id: p.id,
      name: p.name,
      source: p.source,
      status: p.status,
      createdAt: p.created_at,
    })),
  });
});

// Showings Completed drill-down — real per-showing records from
// /reporting/showings. CORRECTED 2026-07-19, per Jason directly: the old
// "completed-looking" substring guess (with an unfiltered fallback for
// when nothing matched) is no longer a guess — CONFIRMED LIVE against a
// real vendor screenshot that the real status value is exactly "Showing
// Complete", their drill-down shows ONLY those rows (not scheduled/
// confirmed/canceled ones too), and their row count matches their tile's
// number exactly. isShowingCompleted (client.ts) is the same shared
// filter the marketing-activity route's tile count now uses, so this
// drill-down's row count can never drift from the tile again. method —
// ADDED same day, matching the vendor's own "Method" column (Self Guided
// vs Accompanied) — see isShowingSelfGuided's comment in client.ts for
// how confident that mapping is.
rentEngineRoutes.get("/api/rentengine/showings", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  const result = await fetchShowingsReport(from, to);
  if (!result.connected) {
    res.json({ connected: false, showings: [] });
    return;
  }
  if (result.error || !result.data) {
    logError("GET /api/rentengine/showings failed", { error: result.error });
    res.status(502).json({ error: "Failed to load showings data from RentEngine.", detail: result.error });
    return;
  }
  const completed = result.data.filter((s) => isShowingCompleted(s.status));
  res.json({
    connected: true,
    showings: completed.map((s) => ({
      showingId: s.showing_id,
      propertyAddress: s.property_address,
      prospectName: s.prospect_name,
      status: s.status,
      // Vendor's own drill-down sorts/displays by when the showing record
      // was logged, not when it was scheduled to happen — confirmed
      // against a real screenshot (a showing logged 7/1 but scheduled for
      // 7/7 appeared under 7/1 on the vendor's site).
      createdAt: s.created_at,
      showingAgent: s.showing_agent,
      feedback: s.feedback,
      method: isShowingSelfGuided(s.showing_agent) ? "Self Guided" : "Accompanied",
    })),
  });
});

// Total Calls drill-down — CORRECTED 2026-07-19, per Jason directly,
// against a real vendor screenshot: this used to list real per-call
// records from /reporting/calls, but the vendor's own drill-down doesn't
// use that endpoint at all — its note says "From RentEngine
// /reporting/leasing-performance/units total_calls field, summed across
// all units," the SAME per-unit source the tile's own number already
// uses (summarizeMarketingActivityFromReporting below), just shown one
// row per unit instead of summed. Rebuilt to match: same shared cache as
// the tile (no extra RentEngine calls), joined with fetchUnits() for
// status (same join pattern as the Completion Rate / Days on Market
// drill-downs), address instead of the vendor's bare unit number per
// Jason directly, sorted by call count descending to match the vendor.
rentEngineRoutes.get("/api/rentengine/calls", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  try {
    const [shared, unitsResult] = await Promise.all([getOrFetchLeasingPerformanceForAllUnits(from, to), fetchUnits()]);
    if (!shared.connected) {
      res.json({ connected: false, units: [] });
      return;
    }
    if (shared.error || !shared.rows) {
      logError("GET /api/rentengine/calls failed", { error: shared.error });
      res.status(502).json({ error: "Failed to load leasing-performance data from RentEngine.", detail: shared.error });
      return;
    }
    if (unitsResult.error || !unitsResult.data) {
      logError("GET /api/rentengine/calls failed", { error: unitsResult.error });
      res.status(502).json({ error: "Failed to load unit data from RentEngine.", detail: unitsResult.error });
      return;
    }
    const unitsById = new Map(unitsResult.data.map((u) => [u.id, u]));
    const units = [...shared.rows]
      .sort((a, b) => b.total_calls - a.total_calls)
      .map((r) => {
        const unit = unitsById.get(r.unit_id);
        return {
          unitId: r.unit_id,
          address: unit?.address?.formatted_address ?? null,
          status: unit?.status ?? null,
          calls: r.total_calls,
        };
      });
    res.json({ connected: true, units });
  } catch (err) {
    logError("GET /api/rentengine/calls failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load call data from RentEngine." });
  }
});

// Outbound Texts drill-down — ADDED 2026-07-19, per Jason directly,
// against a real vendor screenshot. The old comment here (removed) argued
// no drill-down could be built without an N+1 per-message crawl — that
// assumed the vendor used row-level message records. CONFIRMED LIVE that's
// wrong: the vendor's own drill-down note reads "From RentEngine
// /reporting/leasing-performance/units outbound_texts field, summed
// across all units" — the exact same per-unit source already fetched for
// the tile's own number (summarizeMarketingActivityFromReporting below),
// same pattern as the Total Calls drill-down above. Zero extra RentEngine
// calls. Address instead of the vendor's bare unit number, per Jason
// directly.
rentEngineRoutes.get("/api/rentengine/outbound-texts", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  try {
    const [shared, unitsResult] = await Promise.all([getOrFetchLeasingPerformanceForAllUnits(from, to), fetchUnits()]);
    if (!shared.connected) {
      res.json({ connected: false, units: [] });
      return;
    }
    if (shared.error || !shared.rows) {
      logError("GET /api/rentengine/outbound-texts failed", { error: shared.error });
      res.status(502).json({ error: "Failed to load leasing-performance data from RentEngine.", detail: shared.error });
      return;
    }
    if (unitsResult.error || !unitsResult.data) {
      logError("GET /api/rentengine/outbound-texts failed", { error: unitsResult.error });
      res.status(502).json({ error: "Failed to load unit data from RentEngine.", detail: unitsResult.error });
      return;
    }
    const unitsById = new Map(unitsResult.data.map((u) => [u.id, u]));
    const units = [...shared.rows]
      .sort((a, b) => b.outbound_texts - a.outbound_texts)
      .map((r) => {
        const unit = unitsById.get(r.unit_id);
        return {
          unitId: r.unit_id,
          address: unit?.address?.formatted_address ?? null,
          status: unit?.status ?? null,
          texts: r.outbound_texts,
        };
      });
    res.json({ connected: true, units });
  } catch (err) {
    logError("GET /api/rentengine/outbound-texts failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load outbound text data from RentEngine." });
  }
});

// Avg Days on Market / Median DOM — share ONE drill-down: the real per-unit
// leasing-performance rows already being fetched
// (src/rentengine/leasingPerformanceCache.ts), just re-shaped as a record
// list instead of an aggregate. Same shared cache as the summary tiles —
// no extra RentEngine calls for this drill-down. Units on Market has its
// own separate drill-down below (SPLIT OFF 2026-07-13 — see that route's
// comment for why sharing this one was wrong).
//
// address/status — ADDED 2026-07-13, per Jason directly, to match the
// vendor's own drill-down (Address/Status/Health/Days columns; ours only
// ever showed a bare unit_id). Joined in from fetchUnits() (already fetched
// elsewhere on this dashboard) by unit id — no extra RentEngine calls.
rentEngineRoutes.get("/api/rentengine/units/leasing-performance", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  try {
    const [shared, unitsResult] = await Promise.all([getOrFetchLeasingPerformanceForAllUnits(from, to), fetchUnits()]);
    if (!shared.connected) {
      res.json({ connected: false, units: [] });
      return;
    }
    if (shared.error || !shared.rows) {
      logError("GET /api/rentengine/units/leasing-performance failed", { error: shared.error });
      res.status(502).json({ error: "Failed to load unit performance data from RentEngine.", detail: shared.error });
      return;
    }
    const unitsById = new Map((unitsResult.data ?? []).map((u) => [u.id, u]));
    res.json({
      connected: true,
      units: shared.rows.map((r) => {
        const unit = unitsById.get(r.unit_id);
        return {
          unitId: r.unit_id,
          address: unit?.address?.formatted_address ?? null,
          status: unit?.status ?? null,
          daysOnMarket: r.days_on_market,
          propertyHealth: r.property_health,
        };
      }),
    });
  } catch (err) {
    logError("GET /api/rentengine/units/leasing-performance failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load unit performance data from RentEngine." });
  }
});

// Units on Market drill-down — ADDED 2026-07-13, per Jason directly. Was
// sharing the Days on Market drill-down above (which lists EVERY tracked
// unit, not just on-market ones) — clicking "Units on Market: N" didn't
// actually show N rows. This is scoped to real on-market units, using the
// SAME isUnitOnMarket predicate as the tile's own summarizeUnitsOnMarket
// count (src/rentengine/client.ts) so the two can never disagree. Base
// list built from fetchUnits() (not the leasing-performance rows) so a
// brand-new listing that hasn't shown up in a reporting window yet still
// appears here with "—" days rather than being silently missing.
rentEngineRoutes.get("/api/rentengine/units/on-market", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  try {
    const [shared, unitsResult] = await Promise.all([getOrFetchLeasingPerformanceForAllUnits(from, to), fetchUnits()]);
    if (!unitsResult.connected) {
      res.json({ connected: false, units: [] });
      return;
    }
    if (unitsResult.error || !unitsResult.data) {
      logError("GET /api/rentengine/units/on-market failed", { error: unitsResult.error });
      res.status(502).json({ error: "Failed to load unit data from RentEngine.", detail: unitsResult.error });
      return;
    }
    const performanceByUnitId = new Map((shared.rows ?? []).map((r) => [r.unit_id, r]));
    const onMarket = unitsResult.data.filter((u) => isUnitOnMarket(u.status));
    res.json({
      connected: true,
      units: onMarket.map((u) => {
        const perf = performanceByUnitId.get(u.id);
        return {
          unitId: u.id,
          address: u.address?.formatted_address ?? null,
          status: u.status,
          daysOnMarket: perf?.days_on_market ?? null,
          propertyHealth: perf?.property_health ?? null,
        };
      }),
    });
  } catch (err) {
    logError("GET /api/rentengine/units/on-market failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load unit data from RentEngine." });
  }
});
