import { fetchLeasingPerformanceForAllUnits, type RentEngineLeasingPerformance } from "./client.js";
import { getCachedMetric, upsertCachedMetric, isCacheFresh, type CachedMetric } from "../db/metricCache.js";
import { logWarn } from "../lib/logger.js";

// Property Health, Days on Market, and Marketing Activity (Total
// Calls/Outbound Texts/New Prospects/Showings Completed) all derive from
// the SAME underlying data: one GET /reporting/leasing-performance/units/{id}
// call per RentEngine-tracked unit (~61 units). CONFIRMED LIVE 2026-07-04:
// fetching all 61 units takes ~50 seconds — three separate routes each
// independently re-running that full fetch (as originally wired) means
// ~150 seconds of redundant real work and 3x the RentEngine API load for
// one dashboard page load. This shared, single cache entry (keyed only by
// date range, not per-metric) means whichever route's request lands first
// does the real fetch, and the other two read the same cached raw rows
// instead of re-fetching.
export interface LeasingPerformanceCacheResult {
  connected: boolean;
  rows: RentEngineLeasingPerformance[] | null;
  error: string | null;
  cached: boolean;
  cachedAt: Date | null;
  stale: boolean;
}

// FOUND LIVE 2026-07-06: the Dashboard tab fires ~20 API calls in parallel
// on page load (see public/js/dashboard.js), and 3 of them
// (property-health, days-on-market, marketing-activity) all depend on this
// same shared fetch. With a cold or stale cache, all 3 request handlers
// land here at nearly the same instant, all see "no fresh cache," and all
// 3 independently kick off their own full ~61-unit RentEngine crawl —
// tripling the real request volume RentEngine sees at once and pushing it
// into much heavier 429 rate-limiting than a single crawl would hit,
// confirmed live to leave requests hanging for minutes instead of the
// normal ~50 seconds. inFlightFetches deduplicates concurrent callers for
// the same cache key so only ONE real fetch ever runs at a time — the
// other callers just await that same in-progress promise instead of
// starting their own.
const inFlightFetches = new Map<string, Promise<LeasingPerformanceCacheResult>>();

export async function getOrFetchLeasingPerformanceForAllUnits(
  fromDate: string,
  toDate: string
): Promise<LeasingPerformanceCacheResult> {
  const cacheKey = `leasing_performance_all_units_${fromDate}_${toDate}`;
  const cached: CachedMetric | null = await getCachedMetric(cacheKey, "portfolio");
  // FIXED 2026-07-06: this only computed staleness to LABEL the response —
  // it never actually stopped serving a stale entry. Confirmed live: a
  // fetch made during the (now-fixed) RentEngine date-format bug cached an
  // empty result set, and every Days on Market read kept silently serving
  // that same empty cache well past the documented 10-minute TTL, with no
  // error anywhere. A fresh (isCacheFresh) hit still short-circuits below;
  // a stale one now falls through to a real refetch instead of being
  // returned as-is.
  if (cached && cached.value !== null && isCacheFresh(cached)) {
    return {
      connected: true,
      rows: cached.value as RentEngineLeasingPerformance[],
      error: null,
      cached: true,
      cachedAt: cached.fetchedAt,
      stale: false,
    };
  }

  const existing = inFlightFetches.get(cacheKey);
  if (existing) return existing;

  const fetchPromise = (async (): Promise<LeasingPerformanceCacheResult> => {
    try {
      const result = await fetchLeasingPerformanceForAllUnits(fromDate, toDate);
      if (!result.connected) {
        return { connected: false, rows: null, error: null, cached: false, cachedAt: null, stale: false };
      }
      if (result.error || !result.data) {
        logWarn("Shared leasing-performance fetch failed", { error: result.error });
        return { connected: true, rows: null, error: result.error, cached: false, cachedAt: null, stale: false };
      }

      await upsertCachedMetric(cacheKey, "portfolio", "rent_engine", result.data);
      return { connected: true, rows: result.data, error: null, cached: false, cachedAt: null, stale: false };
    } finally {
      inFlightFetches.delete(cacheKey);
    }
  })();

  inFlightFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
}
