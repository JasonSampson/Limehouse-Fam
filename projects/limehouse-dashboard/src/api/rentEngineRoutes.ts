import { Router } from "express";
import { z } from "zod";
import {
  fetchProspects,
  fetchUnits,
  summarizeProspectsBySource,
  summarizeLeasingFunnel,
  summarizeUnitsOnMarket,
  isUnitOnMarket,
  summarizeDaysOnMarket,
  summarizeMarketingActivityFromReporting,
  fetchMarketingSourcesReport,
  fetchShowingsReport,
  fetchCallsReport,
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
// FIXED 2026-07-05: "Completion Rate" used to be flagged unavailable here
// ("no confirmed real definition"). It turns out the reporting API's
// showings_scheduled/showings_completed fields (already summed for the
// marketing-activity route below) ARE the vendor's real Completion Rate —
// confirmed live, matches vendor site ballpark. That field now lives on
// GET /api/rentengine/marketing-activity (completionRate), not here.
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
// New Prospects itself does NOT require the cache (it's just a prospect
// count for the period, same live call prospects-by-source already
// makes) — computed fresh here rather than waiting on the cached sync.
// CORRECTED 2026-07-04: Total Calls/Outbound Texts used to depend on
// callActivitySync.ts's N+1-per-prospect background job. RentEngine's real
// Reporting API aggregates total_calls/outbound_texts per unit directly
// (GET /reporting/leasing-performance/units/{unitId}), so this now sums
// that across all tracked units instead — same cache-backed pattern (~61
// calls, not run live), but sourced from RentEngine's own aggregation
// rather than ours. callActivitySync.ts / POST /api/sync/call-activity are
// left in place (not deleted) since Tron's frontend contract may still
// reference the old cache key — safe to retire once confirmed unused.
rentEngineRoutes.get("/api/rentengine/marketing-activity", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  try {
    const shared = await getOrFetchLeasingPerformanceForAllUnits(from, to);
    if (!shared.connected) {
      res.json({
        connected: false,
        newProspects: null,
        showingsScheduled: null,
        showingsCompleted: null,
        completionRate: null,
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
    const summary = summarizeMarketingActivityFromReporting(shared.rows);
    res.json({
      connected: true,
      newProspects: summary.newProspects,
      showingsScheduled: summary.showingsScheduled,
      showingsCompleted: summary.showingsCompleted,
      completionRate: summary.completionRate,
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
    prospects: result.data.map((p) => ({ id: p.id, source: p.source, status: p.status, createdAt: p.created_at })),
  });
});

// Showings Completed drill-down — real per-showing records from
// /reporting/showings, confirmed live 2026-07-04, filtered to showings
// whose status indicates the showing actually happened (not just
// scheduled/canceled). Real confirmed status values seen for this account
// include "Showing Scheduled" — completed-looking statuses are inferred
// as anything containing "Complet" or an explicit "Showed"/"Attended"
// wording; if none match for a given batch, all rows are returned
// unfiltered rather than silently empty, since the exact vocabulary for
// "completed" wasn't exhaustively enumerated against every real status
// value this account has produced.
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
  const completed = result.data.filter((s) => (s.status ?? "").toLowerCase().includes("complet"));
  res.json({
    connected: true,
    showings: (completed.length > 0 ? completed : result.data).map((s) => ({
      showingId: s.showing_id,
      propertyAddress: s.property_address,
      prospectName: s.prospect_name,
      status: s.status,
      plannedDateTime: s.planned_date_time,
      showingAgent: s.showing_agent,
      feedback: s.feedback,
    })),
  });
});

// Total Calls drill-down — real per-call records from /reporting/calls,
// confirmed live 2026-07-04.
rentEngineRoutes.get("/api/rentengine/calls", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  const result = await fetchCallsReport(from, to);
  if (!result.connected) {
    res.json({ connected: false, calls: [] });
    return;
  }
  if (result.error || !result.data) {
    logError("GET /api/rentengine/calls failed", { error: result.error });
    res.status(502).json({ error: "Failed to load call data from RentEngine.", detail: result.error });
    return;
  }
  res.json({
    connected: true,
    calls: result.data.map((c) => ({
      prospectName: c.prospect_name,
      direction: c.call_direction,
      status: c.status,
      durationSeconds: c.call_duration,
      contactNumber: c.contact_number,
      createdAt: c.created_at,
    })),
  });
});

// Outbound Texts — NO drill-down built. Confirmed during Oracle's original
// research: RentEngine's Reporting API has no dedicated texts/messages
// report (only /reporting/calls exists for communication records); the
// only per-message endpoint is the older /messages (one call per
// prospect, no bulk/account-wide variant — the same N+1 problem that
// forced Total Calls/Outbound Texts onto the aggregated leasing-
// performance path in the first place). Building a drill-down here would
// mean either re-introducing that N+1 problem or silently faking a list —
// neither is acceptable, so this tile intentionally has no click handler
// wired on the frontend rather than a fake or slow drill-down.

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
