import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeProspectSource,
  summarizeProspectsBySource,
  summarizeLeasingFunnel,
  summarizeUnitsOnMarket,
  summarizeDaysOnMarket,
  summarizePropertyHealthFromReporting,
  summarizeMarketingActivityFromReporting,
  dedupeById,
  type RentEngineProspect,
  type RentEngineUnit,
  type RentEngineLeasingPerformance,
} from "../../src/rentengine/client.js";

function prospect(overrides: Partial<RentEngineProspect>): RentEngineProspect {
  return {
    id: 1,
    status: "New",
    source: "Zillow",
    unit_of_interest: null,
    created_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

function unit(overrides: Partial<RentEngineUnit>): RentEngineUnit {
  return {
    id: 1,
    status: "Available",
    is_occupied: false,
    earliest_showing_date: null,
    earliest_move_in_date: null,
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function leasingPerformance(overrides: Partial<RentEngineLeasingPerformance>): RentEngineLeasingPerformance {
  return {
    unit_id: 1,
    days_on_market: 20,
    property_health: "Healthy",
    new_prospects: 0,
    showings_scheduled: 0,
    showings_completed: 0,
    applications_requested: 0,
    applications_submitted: 0,
    active_prospects: 0,
    upcoming_showings: 0,
    outbound_texts: 0,
    total_calls: 0,
    showing_feedback: [],
    ...overrides,
  };
}

// CONFIRMED LIVE 2026-07-03: real source values include case/naming
// duplicates for the same underlying source ("Rent.com" / "rent.com" /
// "rent"). This is the exact regression normalizeProspectSource exists to
// collapse.
describe("normalizeProspectSource", () => {
  it("collapses known Rent.com casing/truncation variants to one canonical form", () => {
    expect(normalizeProspectSource("Rent.com")).toBe("Rent.com");
    expect(normalizeProspectSource("rent.com")).toBe("Rent.com");
    expect(normalizeProspectSource("rent")).toBe("Rent.com");
  });

  it("passes through an unrecognized source unchanged rather than forcing it into a fixed enum", () => {
    expect(normalizeProspectSource("Hotpads")).toBe("Hotpads");
    expect(normalizeProspectSource("Phone Call")).toBe("Phone Call");
    expect(normalizeProspectSource("For Rent Sign")).toBe("For Rent Sign");
    expect(normalizeProspectSource("Walk-In")).toBe("Walk-In");
  });

  it("trims whitespace", () => {
    expect(normalizeProspectSource("  Zillow  ")).toBe("Zillow");
  });
});

// FIXED 2026-07-05: root cause of the "New Prospects" 3-way tile/drill-
// down/chart mismatch (drill-down always ~2 higher than the tile and
// by-source chart for the same period). CONFIRMED LIVE: rentEngineGetAllProspectPages'
// cursor pagination (anchoring the next page's created_after on the
// previous page's own last record) re-fetches that boundary record once
// per page crossed — real account showed 249 raw rows for only 247
// distinct ids. dedupeById is the fix, applied after collecting all pages.
describe("dedupeById", () => {
  it("keeps the first occurrence of a repeated id and drops later duplicates", () => {
    const rows = [{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 1, v: "c" }];
    expect(dedupeById(rows)).toEqual([{ id: 1, v: "a" }, { id: 2, v: "b" }]);
  });

  it("preserves original order for rows with no duplicates", () => {
    const rows = [{ id: 3, v: "x" }, { id: 1, v: "y" }, { id: 2, v: "z" }];
    expect(dedupeById(rows)).toEqual(rows);
  });

  it("returns an empty array for an empty input", () => {
    expect(dedupeById([])).toEqual([]);
  });

  it("matches the real pagination-boundary case: a page-boundary record repeated across two page fetches", () => {
    // Simulates the real bug: page 1 ends with id 100, page 2 (anchored on
    // that same record's created_at) starts by re-returning id 100.
    const page1 = [{ id: 98, v: "a" }, { id: 99, v: "b" }, { id: 100, v: "c" }];
    const page2 = [{ id: 100, v: "c" }, { id: 101, v: "d" }];
    expect(dedupeById([...page1, ...page2])).toEqual([
      { id: 98, v: "a" },
      { id: 99, v: "b" },
      { id: 100, v: "c" },
      { id: 101, v: "d" },
    ]);
  });
});

describe("summarizeProspectsBySource", () => {
  it("groups normalized sources and counts, sorted highest first", () => {
    const prospects = [
      prospect({ source: "Zillow" }),
      prospect({ source: "Rent.com" }),
      prospect({ source: "rent.com" }),
      prospect({ source: "rent" }),
      prospect({ source: "Zillow" }),
    ];
    const result = summarizeProspectsBySource(prospects);
    expect(result).toEqual([
      { source: "Rent.com", count: 3 },
      { source: "Zillow", count: 2 },
    ]);
  });

  it("returns an empty array for no prospects", () => {
    expect(summarizeProspectsBySource([])).toEqual([]);
  });
});

// Real confirmed status values (leasing_event_type enum) — a prospect
// counts toward every funnel stage it has passed through, not just its
// current status.
describe("summarizeLeasingFunnel", () => {
  it("counts prospects at every stage they've passed through", () => {
    const prospects = [
      prospect({ status: "New" }),
      prospect({ status: "Contacted" }),
      prospect({ status: "Showing Desired" }),
      prospect({ status: "Application Received" }),
      prospect({ status: "Moved In" }),
    ];
    const result = summarizeLeasingFunnel(prospects);
    expect(result).toEqual({
      prospects: 5,
      showingsScheduled: 3, // Showing Desired, Application Received, Moved In
      showingsCompleted: 2, // Application Received, Moved In
      applications: 2, // Application Received, Moved In
      moveIns: 1,
    });
  });

  it("does not count early-stage statuses toward later funnel stages", () => {
    const prospects = [prospect({ status: "New" }), prospect({ status: "Not Interested" })];
    const result = summarizeLeasingFunnel(prospects);
    expect(result).toEqual({ prospects: 2, showingsScheduled: 0, showingsCompleted: 0, applications: 0, moveIns: 0 });
  });

  it("handles an empty prospect list", () => {
    expect(summarizeLeasingFunnel([])).toEqual({
      prospects: 0,
      showingsScheduled: 0,
      showingsCompleted: 0,
      applications: 0,
      moveIns: 0,
    });
  });
});

// CONFIRMED LIVE 2026-07-03: status="Available" is used regardless of
// is_occupied, per the documented judgment call in client.ts (pre-leased
// units keep marketing until move-out).
describe("summarizeUnitsOnMarket", () => {
  it("counts status=Available units as on-market even if currently occupied (pre-leased)", () => {
    const units = [
      unit({ id: 1, status: "Available", is_occupied: false }),
      unit({ id: 2, status: "Available", is_occupied: true, earliest_move_in_date: "2026-08-01" }),
      unit({ id: 3, status: "Leased", is_occupied: true }),
    ];
    const result = summarizeUnitsOnMarket(units);
    expect(result).toEqual({ unitsOnMarket: 2, totalUnitsTracked: 3 });
  });

  it("excludes Leased units even if is_occupied is false (stale-listing case)", () => {
    const units = [unit({ status: "Leased", is_occupied: false })];
    const result = summarizeUnitsOnMarket(units);
    expect(result.unitsOnMarket).toBe(0);
  });

  it("returns zero for an empty unit list", () => {
    expect(summarizeUnitsOnMarket([])).toEqual({ unitsOnMarket: 0, totalUnitsTracked: 0 });
  });
});

// CONFIRMED LIVE 2026-07-04: GET /reporting/leasing-performance/units/{id}
// returns days_on_market directly (real sample: unit 41121 = 19). Replaces
// the earlier "genuinely not available" conclusion, which was correct for
// /units but not for this separate Reporting API endpoint.
//
// FIXED 2026-07-04: all fixture rows below default to property_health:
// "Healthy" (see the leasingPerformance() factory above) since
// summarizeDaysOnMarket now filters to on-market (Healthy) units only —
// see the dedicated describe block further down for the off-market
// exclusion behavior itself, confirmed against real account data (vendor
// side-by-side: avg 28 / median 15 only match when scoped to the 17
// Healthy units, not all 61 tracked units).
describe("summarizeDaysOnMarket", () => {
  it("computes average and median across on-market units with data, ignoring nulls", () => {
    const rows = [
      leasingPerformance({ unit_id: 1, days_on_market: 10 }),
      leasingPerformance({ unit_id: 2, days_on_market: 20 }),
      leasingPerformance({ unit_id: 3, days_on_market: 30 }),
      leasingPerformance({ unit_id: 4, days_on_market: null }),
    ];
    const result = summarizeDaysOnMarket(rows);
    expect(result).toEqual({ avgDaysOnMarket: 20, medianDaysOnMarket: 20, unitsWithData: 3, unitsTotal: 4 });
  });

  it("averages the two middle values for an even count", () => {
    const rows = [
      leasingPerformance({ unit_id: 1, days_on_market: 10 }),
      leasingPerformance({ unit_id: 2, days_on_market: 20 }),
    ];
    const result = summarizeDaysOnMarket(rows);
    expect(result.medianDaysOnMarket).toBe(15);
  });

  it("returns nulls when no unit has data", () => {
    const rows = [leasingPerformance({ days_on_market: null })];
    const result = summarizeDaysOnMarket(rows);
    expect(result).toEqual({ avgDaysOnMarket: null, medianDaysOnMarket: null, unitsWithData: 0, unitsTotal: 1 });
  });

  it("handles an empty list", () => {
    expect(summarizeDaysOnMarket([])).toEqual({
      avgDaysOnMarket: null,
      medianDaysOnMarket: null,
      unitsWithData: 0,
      unitsTotal: 0,
    });
  });

  // Regression test for the real bug found 2026-07-04 comparing against
  // the vendor site: averaging across ALL tracked units (including
  // Off-Market ones with frozen/stale days_on_market values from a past
  // listing period) pulled the average down to 23 when the real
  // currently-on-market average was 28. Off-Market rows must not count
  // toward this metric at all, not just be de-weighted.
  it("excludes Off-Market units even when they have a days_on_market value", () => {
    const rows = [
      leasingPerformance({ unit_id: 1, days_on_market: 100, property_health: "Healthy" }),
      leasingPerformance({ unit_id: 2, days_on_market: 1, property_health: "Off-Market" }),
      leasingPerformance({ unit_id: 3, days_on_market: 0, property_health: "Off-Market" }),
    ];
    const result = summarizeDaysOnMarket(rows);
    expect(result).toEqual({ avgDaysOnMarket: 100, medianDaysOnMarket: 100, unitsWithData: 1, unitsTotal: 1 });
  });

  it("excludes non-Healthy statuses generally (At-risk, Waitlist, On Hold, Commercial, Unknown), not just Off-Market", () => {
    const rows = [
      leasingPerformance({ unit_id: 1, days_on_market: 50, property_health: "Healthy" }),
      leasingPerformance({ unit_id: 2, days_on_market: 5, property_health: "At-risk" }),
      leasingPerformance({ unit_id: 3, days_on_market: 5, property_health: "Waitlist" }),
      leasingPerformance({ unit_id: 4, days_on_market: 5, property_health: "On Hold" }),
      leasingPerformance({ unit_id: 5, days_on_market: 5, property_health: "Commercial" }),
      leasingPerformance({ unit_id: 6, days_on_market: 5, property_health: "Unknown" }),
    ];
    const result = summarizeDaysOnMarket(rows);
    expect(result.unitsWithData).toBe(1);
    expect(result.avgDaysOnMarket).toBe(50);
  });
});

// CONFIRMED LIVE 2026-07-04: property_health enum values ("Off-Market",
// "Healthy", "At-risk", "On Hold", "Waitlist", "Commercial", "Unknown")
// match the real vendor site exactly — this replaces the Buildium-derived
// formula in src/kpi/propertyHealth.ts, which never had a real way to
// produce Waitlist or On Hold.
describe("summarizePropertyHealthFromReporting", () => {
  it("counts units per real category", () => {
    const rows = [
      leasingPerformance({ unit_id: 1, property_health: "Healthy" }),
      leasingPerformance({ unit_id: 2, property_health: "Healthy" }),
      leasingPerformance({ unit_id: 3, property_health: "Off-Market" }),
      leasingPerformance({ unit_id: 4, property_health: "Waitlist" }),
    ];
    const result = summarizePropertyHealthFromReporting(rows);
    expect(result.totalUnits).toBe(4);
    expect(result.countsByCategory).toEqual({
      Healthy: 2,
      "At-risk": 0,
      Waitlist: 1,
      "On Hold": 0,
      "Off-Market": 1,
      Commercial: 0,
      Unknown: 0,
    });
  });

  it("routes an unrecognized future category value to Unknown rather than crashing", () => {
    const rows = [leasingPerformance({ property_health: "Some New Category RentEngine Adds Later" })];
    const result = summarizePropertyHealthFromReporting(rows);
    expect(result.countsByCategory.Unknown).toBe(1);
  });

  it("handles an empty list", () => {
    const result = summarizePropertyHealthFromReporting([]);
    expect(result.totalUnits).toBe(0);
    expect(Object.values(result.countsByCategory).every((c) => c === 0)).toBe(true);
  });
});

// FIXED 2026-07-05: completionRate (showingsCompleted/showingsScheduled*100)
// was previously never computed anywhere, even though both inputs were
// already being summed here — the dashboard's Completion Rate tile showed
// "Not a RentEngine concept" instead of a real number. This is the vendor's
// own definition, confirmed live.
describe("summarizeMarketingActivityFromReporting", () => {
  it("sums fields across all units", () => {
    const rows = [
      leasingPerformance({ unit_id: 1, new_prospects: 3, showings_scheduled: 2, showings_completed: 1, applications_submitted: 1, total_calls: 5, outbound_texts: 10 }),
      leasingPerformance({ unit_id: 2, new_prospects: 2, showings_scheduled: 1, showings_completed: 1, applications_submitted: 0, total_calls: 3, outbound_texts: 4 }),
    ];
    const result = summarizeMarketingActivityFromReporting(rows);
    expect(result).toEqual({
      newProspects: 5,
      showingsScheduled: 3,
      showingsCompleted: 2,
      applicationsSubmitted: 1,
      totalCalls: 8,
      outboundTexts: 14,
      completionRate: (2 / 3) * 100,
    });
  });

  it("returns all zeros and a null completion rate for an empty list", () => {
    const result = summarizeMarketingActivityFromReporting([]);
    expect(result).toEqual({
      newProspects: 0,
      showingsScheduled: 0,
      showingsCompleted: 0,
      applicationsSubmitted: 0,
      totalCalls: 0,
      outboundTexts: 0,
      completionRate: null,
    });
  });

  it("computes completion rate as a 0-100 percentage, not a 0-1 ratio", () => {
    const rows = [leasingPerformance({ showings_scheduled: 4, showings_completed: 3 })];
    const result = summarizeMarketingActivityFromReporting(rows);
    expect(result.completionRate).toBe(75);
  });

  it("returns null (not zero, not NaN) when showingsScheduled is 0, even if showingsCompleted is nonzero", () => {
    // Shouldn't happen with real data, but guards the division-by-zero case explicitly.
    const rows = [leasingPerformance({ showings_scheduled: 0, showings_completed: 0 })];
    const result = summarizeMarketingActivityFromReporting(rows);
    expect(result.completionRate).toBeNull();
  });
});

// FIXED 2026-07-05: CONFIRMED LIVE that fetching all ~61 RentEngine-tracked
// units produces real HTTP 429s, which were previously logged and silently
// skipped on the first failure — quietly under-counting every metric
// derived from leasing-performance rows. rentEngineGet() now retries a 429
// with backoff (honoring a real Retry-After header when present) before
// giving up. These tests exercise that retry through the one exported
// function that calls rentEngineGet with a single real HTTP request per
// call: fetchLeasingPerformanceForUnit.
describe("rentEngineGet 429 retry (via fetchLeasingPerformanceForUnit)", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    process.env.RENTENGINE_API_KEY = "test_key";
    process.env.RENTENGINE_BASE_URL = "https://app.rentengine.test/api/public/v1";
    process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
    process.env.BUILDIUM_CLIENT_ID = "test_id";
    process.env.BUILDIUM_CLIENT_SECRET = "test_secret";
    process.env.SESSION_COOKIE_SECRET = "test_secret_at_least_16_chars_long";
    process.env.ENTRA_TENANT_ID = "test-tenant";
    process.env.ENTRA_CLIENT_ID = "test-client";
    process.env.ENTRA_CLIENT_SECRET = "test-client-secret";
    process.env.ENTRA_REDIRECT_URI = "https://localhost:3100/auth/callback";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function rateLimitedResponse(retryAfterHeader?: string) {
    return {
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name === "Retry-After" ? retryAfterHeader ?? null : null) },
      text: async () => "rate limited",
      json: async () => ({}),
    };
  }

  function okLeasingPerformanceResponse(unitId: number) {
    const body = {
      unit_id: unitId,
      days_on_market: 10,
      property_health: "Healthy",
      new_prospects: 1,
      showings_scheduled: 1,
      showings_completed: 1,
      applications_requested: 0,
      applications_submitted: 0,
      active_prospects: 0,
      upcoming_showings: 0,
      outbound_texts: 0,
      total_calls: 0,
      showing_feedback: [],
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  it("retries after a 429 and succeeds once RentEngine stops rate limiting", async () => {
    mockFetch
      .mockResolvedValueOnce(rateLimitedResponse())
      .mockResolvedValueOnce(okLeasingPerformanceResponse(41121));

    const { fetchLeasingPerformanceForUnit } = await import("../../src/rentengine/client.js");
    const result = await fetchLeasingPerformanceForUnit(41121, "2026-06-01", "2026-07-01");

    expect(result.unit_id).toBe(41121);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("honors a real Retry-After header instead of the default backoff", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(rateLimitedResponse("0")) // Retry-After: 0 seconds — resolve near-instantly
      .mockResolvedValueOnce(okLeasingPerformanceResponse(1));

    const { fetchLeasingPerformanceForUnit } = await import("../../src/rentengine/client.js");
    const promise = fetchLeasingPerformanceForUnit(1, "2026-06-01", "2026-07-01");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.unit_id).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("gives up and throws after retries are exhausted, so the caller's existing skip-and-log logic still fires", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(rateLimitedResponse()); // always 429

    const { fetchLeasingPerformanceForUnit, RentEngineApiError } = await import("../../src/rentengine/client.js");
    const promise = fetchLeasingPerformanceForUnit(1, "2026-06-01", "2026-07-01");
    const assertion = expect(promise).rejects.toBeInstanceOf(RentEngineApiError);
    await vi.runAllTimersAsync();
    await assertion;

    // 1 initial attempt + 3 backoff retries = 4 total requests before giving up.
    expect(mockFetch).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});
