import { describe, it, expect } from "vitest";
import { summarizeOccupancy, summarizeLeaseMix, upcomingRenewals } from "../../src/kpi/occupancy.js";
import type { BuildiumLease } from "../../src/buildium/client.js";

function lease(overrides: Partial<BuildiumLease>): BuildiumLease {
  return {
    Id: 1,
    PropertyId: 1,
    UnitId: 1,
    UnitNumber: "1A",
    LeaseStatus: "Active",
    LeaseType: "Fixed",
    LeaseFromDate: "2026-01-01",
    LeaseToDate: "2026-12-31",
    IsEvictionPending: false,
    PaymentDueDay: 1,
    CurrentTenants: null,
    ...overrides,
  };
}

describe("summarizeOccupancy", () => {
  it("computes occupied/vacant/rate from distinct occupied unit ids", () => {
    const leases = [lease({ UnitId: 1 }), lease({ UnitId: 2 }), lease({ UnitId: 3 })];
    const result = summarizeOccupancy(230, leases);
    expect(result).toEqual({ totalUnits: 230, occupiedUnits: 3, vacantUnits: 227, occupancyRatePercent: 1.3 });
  });

  it("counts a unit with two Active lease rows (transition) only once", () => {
    const leases = [lease({ Id: 1, UnitId: 5 }), lease({ Id: 2, UnitId: 5 })];
    const result = summarizeOccupancy(10, leases);
    expect(result.occupiedUnits).toBe(1);
  });

  it("returns 0% occupancy rate (not NaN/divide-by-zero) when totalUnits is 0", () => {
    const result = summarizeOccupancy(0, []);
    expect(result.occupancyRatePercent).toBe(0);
  });

  it("caps occupiedUnits at totalUnits even if lease data is inconsistent", () => {
    const leases = [lease({ UnitId: 1 }), lease({ UnitId: 2 }), lease({ UnitId: 3 })];
    const result = summarizeOccupancy(2, leases);
    expect(result.occupiedUnits).toBe(2);
    expect(result.vacantUnits).toBe(0);
  });
});

describe("summarizeLeaseMix", () => {
  it("buckets Fixed and FixedWithRollover as fixed-term, AtWill as month-to-month", () => {
    const leases = [
      lease({ LeaseType: "Fixed" }),
      lease({ LeaseType: "FixedWithRollover" }),
      lease({ LeaseType: "AtWill" }),
    ];
    const result = summarizeLeaseMix(leases);
    expect(result.fixedTermCount).toBe(2);
    expect(result.monthToMonthCount).toBe(1);
    expect(result.totalActiveLeaseCount).toBe(3);
  });

  it("counts eviction-pending leases independent of lease type", () => {
    const leases = [lease({ IsEvictionPending: true }), lease({ IsEvictionPending: false })];
    const result = summarizeLeaseMix(leases);
    expect(result.evictionPendingCount).toBe(1);
  });

  it("does not misclassify an unexpected LeaseType value into either bucket", () => {
    const leases = [lease({ LeaseType: "SomethingUnexpected" })];
    const result = summarizeLeaseMix(leases);
    expect(result.fixedTermCount).toBe(0);
    expect(result.monthToMonthCount).toBe(0);
    expect(result.totalActiveLeaseCount).toBe(1); // gap is visible, not hidden
  });
});

describe("upcomingRenewals", () => {
  const asOf = new Date("2026-07-03T00:00:00Z");

  it("includes leases ending within the window, sorted soonest first", () => {
    const leases = [
      lease({ Id: 1, LeaseToDate: "2026-09-01" }), // 60 days out
      lease({ Id: 2, LeaseToDate: "2026-08-02" }), // 30 days out
      lease({ Id: 3, LeaseToDate: "2027-01-01" }), // way out, excluded
    ];
    const result = upcomingRenewals(leases, asOf, 60);
    expect(result.map((r) => r.leaseId)).toEqual(["2", "1"]);
  });

  it("excludes month-to-month leases (no LeaseToDate)", () => {
    const leases = [lease({ LeaseToDate: null })];
    const result = upcomingRenewals(leases, asOf, 60);
    expect(result).toEqual([]);
  });

  it("excludes leases that already expired (negative days)", () => {
    const leases = [lease({ LeaseToDate: "2026-06-01" })];
    const result = upcomingRenewals(leases, asOf, 60);
    expect(result).toEqual([]);
  });
});
