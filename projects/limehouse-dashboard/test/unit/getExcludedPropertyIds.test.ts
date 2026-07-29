import { describe, it, expect, vi } from "vitest";

// Regression coverage for the TARS-found gap (2026-07-30): getExcludedPropertyIds
// had zero test coverage despite feeding 7+ routes (occupancy, occupancy-history,
// avg-days-vacant, avg-days-vacant/units, property-health, CEO View income,
// Team Performance kpi-explain) and cacheRefreshJobs.ts's team-performance sync.
// Its two documented behaviors — "empty set if cache never populated" and
// "unwraps value.excluded[].propertyId" — were never exercised by a test, so a
// shape change to the cached value (e.g. a bad write from its own sync job)
// would silently break every consumer with nothing to catch it.
//
// Mocks the DB layer directly (same pattern as test/unit/getScoredRoles.test.ts)
// rather than calling getCachedMetric itself, since getCachedMetric already has
// its own coverage — this exercises getExcludedPropertyIds' own unwrapping logic
// against realistic dashboard_metric_cache row shapes.
const mockQuery = vi.fn();
vi.mock("../../src/db/pool.js", () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted above imports by
// vitest, so this ordering is safe) so getExcludedPropertyIds picks up the
// mocked getPool() via getCachedMetric.
const { getExcludedPropertyIds } = await import("../../src/kpi/terminatedProperties.js");

// Row shape matching exactly what getCachedMetric's real SQL query selects
// (snake_case columns, as `pg` would return them) — see src/db/metricCache.ts.
function cacheRow(overrides: Partial<Record<string, unknown>>) {
  return {
    metric_key: "terminated_properties",
    scope: "portfolio",
    source_system: "buildium",
    value: null,
    fetched_at: new Date("2026-07-29T12:00:00Z"),
    last_error: null,
    last_error_at: null,
    ...overrides,
  };
}

describe("getExcludedPropertyIds", () => {
  it("returns an empty set when the sync has never run (no cache row at all)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getExcludedPropertyIds();
    expect(result).toEqual(new Set());
  });

  it("returns an empty set when a cache row exists but its value is null (e.g. a recorded sync failure with nothing successful yet)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [cacheRow({ value: null, last_error: "LeadSimple timeout" })] });
    const result = await getExcludedPropertyIds();
    expect(result).toEqual(new Set());
  });

  it("unwraps value.excluded[].propertyId into a Set for a single excluded property", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [cacheRow({ value: { excluded: [{ propertyId: "540100", address: "3400 Landstown Court", stage: "Owner Selling Property", terminatedAt: "2026-05-01T00:00:00Z" }] } })],
    });
    const result = await getExcludedPropertyIds();
    expect(result).toEqual(new Set(["540100"]));
  });

  it("unwraps multiple excluded properties into a Set with all of their IDs", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        cacheRow({
          value: {
            excluded: [
              { propertyId: "540100", address: "3400 Landstown Court", stage: "Owner Selling Property", terminatedAt: "2026-05-01T00:00:00Z" },
              { propertyId: "600864", address: "300 Garrison Place", stage: "Owner Terminating Management", terminatedAt: "2026-06-01T00:00:00Z" },
            ],
          },
        }),
      ],
    });
    const result = await getExcludedPropertyIds();
    expect(result).toEqual(new Set(["540100", "600864"]));
  });

  it("returns an empty set (not a crash) when value.excluded is an empty array", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [cacheRow({ value: { excluded: [] } })] });
    const result = await getExcludedPropertyIds();
    expect(result).toEqual(new Set());
  });
});
