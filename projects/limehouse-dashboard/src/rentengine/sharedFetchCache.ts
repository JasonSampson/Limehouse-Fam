import {
  fetchProspects,
  fetchUnits,
  fetchMarketingSourcesReport,
  fetchShowingsReport,
  type RentEngineProspect,
  type RentEngineUnit,
  type RentEngineResult,
  type RentEngineMarketingSourceRow,
  type RentEngineShowingReportRow,
} from "./client.js";
import { getCachedMetric, upsertCachedMetric, isCacheFresh } from "../db/metricCache.js";

// Mirrors leasingPerformanceCache.ts's getOrFetchLeasingPerformanceForAllUnits
// exactly — same real bug, two more call sites. FOUND LIVE 2026-07-30: the
// Dashboard page fires fetchProspects(from, to) from BOTH the Leasing
// Funnel tile and the Marketing Activity tile (identical date range,
// identical data), and fetchUnits() from BOTH Units on Market and
// Completion Rate — each pair independently re-running the same paginated
// RentEngine crawl on every single page load. With Jason now at 8-9
// regular users, that doubled real request volume against RentEngine's
// confirmed hard 30 req/min limit was a real contributor to multi-minute
// loads, on top of colliding with the scheduled background syncs. Same
// fix as before: a short DB-backed cache (10-minute TTL, same as
// leasingPerformanceCache.ts) plus in-flight-request dedup so concurrent
// callers within that window share one real fetch instead of each
// starting their own.
const inFlightProspectFetches = new Map<string, Promise<RentEngineResult<RentEngineProspect[]>>>();

export async function getOrFetchProspects(fromDate: string, toDate: string): Promise<RentEngineResult<RentEngineProspect[]>> {
  const cacheKey = `prospects_${fromDate}_${toDate}`;
  const cached = await getCachedMetric(cacheKey, "portfolio");
  if (cached && cached.value !== null && isCacheFresh(cached)) {
    return { connected: true, data: cached.value as RentEngineProspect[], error: null };
  }

  const existing = inFlightProspectFetches.get(cacheKey);
  if (existing) return existing;

  const fetchPromise = (async (): Promise<RentEngineResult<RentEngineProspect[]>> => {
    try {
      const result = await fetchProspects(fromDate, toDate);
      // Only a genuinely successful fetch gets cached — never a "not
      // connected" or error result, so a transient RentEngine outage
      // doesn't get stuck serving a fake-broken state for the TTL.
      if (result.connected && result.data) {
        await upsertCachedMetric(cacheKey, "portfolio", "rent_engine", result.data);
      }
      return result;
    } finally {
      inFlightProspectFetches.delete(cacheKey);
    }
  })();

  inFlightProspectFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
}

const inFlightUnitsFetches = new Map<string, Promise<RentEngineResult<RentEngineUnit[]>>>();

export async function getOrFetchUnits(): Promise<RentEngineResult<RentEngineUnit[]>> {
  const cacheKey = "units_all";
  const cached = await getCachedMetric(cacheKey, "portfolio");
  if (cached && cached.value !== null && isCacheFresh(cached)) {
    return { connected: true, data: cached.value as RentEngineUnit[], error: null };
  }

  const existing = inFlightUnitsFetches.get(cacheKey);
  if (existing) return existing;

  const fetchPromise = (async (): Promise<RentEngineResult<RentEngineUnit[]>> => {
    try {
      const result = await fetchUnits();
      if (result.connected && result.data) {
        await upsertCachedMetric(cacheKey, "portfolio", "rent_engine", result.data);
      }
      return result;
    } finally {
      inFlightUnitsFetches.delete(cacheKey);
    }
  })();

  inFlightUnitsFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
}

// ADDED 2026-07-30, per Hermes's performance review: fetchMarketingSourcesReport
// and fetchShowingsReport were the only two RentEngine report fetches left
// uncached — not duplicated within a single page load the way prospects/units
// were, but both paginate in up to 32-day chunks against the same tight 30
// req/min budget, so a wide period ("Last year") could still burn a real
// chunk of it in one burst. Same cache/dedup pattern as above for
// consistency and extra headroom.
const inFlightMarketingSourcesFetches = new Map<string, Promise<RentEngineResult<RentEngineMarketingSourceRow[]>>>();

export async function getOrFetchMarketingSourcesReport(
  fromDate: string,
  toDate: string
): Promise<RentEngineResult<RentEngineMarketingSourceRow[]>> {
  const cacheKey = `marketing_sources_${fromDate}_${toDate}`;
  const cached = await getCachedMetric(cacheKey, "portfolio");
  if (cached && cached.value !== null && isCacheFresh(cached)) {
    return { connected: true, data: cached.value as RentEngineMarketingSourceRow[], error: null };
  }

  const existing = inFlightMarketingSourcesFetches.get(cacheKey);
  if (existing) return existing;

  const fetchPromise = (async (): Promise<RentEngineResult<RentEngineMarketingSourceRow[]>> => {
    try {
      const result = await fetchMarketingSourcesReport(fromDate, toDate);
      if (result.connected && result.data) {
        await upsertCachedMetric(cacheKey, "portfolio", "rent_engine", result.data);
      }
      return result;
    } finally {
      inFlightMarketingSourcesFetches.delete(cacheKey);
    }
  })();

  inFlightMarketingSourcesFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
}

const inFlightShowingsFetches = new Map<string, Promise<RentEngineResult<RentEngineShowingReportRow[]>>>();

export async function getOrFetchShowingsReport(
  fromDate: string,
  toDate: string
): Promise<RentEngineResult<RentEngineShowingReportRow[]>> {
  const cacheKey = `showings_report_${fromDate}_${toDate}`;
  const cached = await getCachedMetric(cacheKey, "portfolio");
  if (cached && cached.value !== null && isCacheFresh(cached)) {
    return { connected: true, data: cached.value as RentEngineShowingReportRow[], error: null };
  }

  const existing = inFlightShowingsFetches.get(cacheKey);
  if (existing) return existing;

  const fetchPromise = (async (): Promise<RentEngineResult<RentEngineShowingReportRow[]>> => {
    try {
      const result = await fetchShowingsReport(fromDate, toDate);
      if (result.connected && result.data) {
        await upsertCachedMetric(cacheKey, "portfolio", "rent_engine", result.data);
      }
      return result;
    } finally {
      inFlightShowingsFetches.delete(cacheKey);
    }
  })();

  inFlightShowingsFetches.set(cacheKey, fetchPromise);
  return fetchPromise;
}
