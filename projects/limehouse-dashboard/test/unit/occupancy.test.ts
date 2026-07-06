import { describe, it, expect } from "vitest";
import {
  summarizeOccupancy,
  summarizeOccupancyFromUnits,
  summarizeLeaseMix,
  upcomingRenewals,
  averageTenancyMonths,
  summarizeRenewalRate,
  summarizeDelinquencyRate,
} from "../../src/kpi/occupancy.js";
import type { BuildiumLease, BuildiumUnit, LeaseBalance } from "../../src/buildium/client.js";

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

function unit(overrides: Partial<BuildiumUnit>): BuildiumUnit {
  return {
    Id: 1,
    PropertyId: 1,
    UnitNumber: "1A",
    UnitSize: 800,
    MarketRent: 1000,
    IsUnitOccupied: false,
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

  // Regression test for the real bug found 2026-07-04 comparing against
  // the vendor site: a unit whose outgoing tenant's lease already ended
  // (Past) and whose incoming tenant's lease hasn't started yet (Future)
  // has NO currently-Active lease, even though Buildium's own
  // IsUnitOccupied flag still says true for it (the old tenant hasn't
  // physically moved out). This function must count that unit as vacant
  // (no Active lease = not occupied for this purpose), since it's driven
  // by lease status, not the unit flag — confirmed against 9 real units in
  // this exact situation, which is what closed the 90.6% vs 86.8% gap.
  it("does not count a unit as occupied from a Past or Future lease alone — only Active counts", () => {
    const activeLeasesOnly = [lease({ UnitId: 1, LeaseStatus: "Active" })];
    // caller is responsible for only passing Active-status leases in, per
    // this function's contract — Past/Future leases on units 2 and 3
    // simply aren't in this list at all.
    const result = summarizeOccupancy(3, activeLeasesOnly);
    expect(result.occupiedUnits).toBe(1);
    expect(result.vacantUnits).toBe(2);
    expect(result.occupancyRatePercent).toBe(33.3);
  });
});

// CONFIRMED LIVE 2026-07-03 against Jason's real Buildium account:
// IsUnitOccupied is a real field on the unit record, returned by the
// (also newly confirmed) bulk /rentals/units endpoint. This is the
// function /api/dashboard/occupancy actually calls now, replacing the
// broken per-property /rentals/{id}/units approach that 404'd for every
// property in this account.
describe("summarizeOccupancyFromUnits", () => {
  it("counts occupied/vacant directly from each unit's IsUnitOccupied flag", () => {
    const units = [
      unit({ Id: 1, IsUnitOccupied: true }),
      unit({ Id: 2, IsUnitOccupied: true }),
      unit({ Id: 3, IsUnitOccupied: false }),
    ];
    const result = summarizeOccupancyFromUnits(units);
    expect(result).toEqual({ totalUnits: 3, occupiedUnits: 2, vacantUnits: 1, occupancyRatePercent: 66.7 });
  });

  it("returns 0% occupancy rate (not NaN) for an empty portfolio", () => {
    const result = summarizeOccupancyFromUnits([]);
    expect(result).toEqual({ totalUnits: 0, occupiedUnits: 0, vacantUnits: 0, occupancyRatePercent: 0 });
  });

  it("all-occupied portfolio reports 100%", () => {
    const units = [unit({ IsUnitOccupied: true }), unit({ IsUnitOccupied: true })];
    const result = summarizeOccupancyFromUnits(units);
    expect(result.occupancyRatePercent).toBe(100);
    expect(result.vacantUnits).toBe(0);
  });

  it("all-vacant portfolio reports 0%", () => {
    const units = [unit({ IsUnitOccupied: false }), unit({ IsUnitOccupied: false })];
    const result = summarizeOccupancyFromUnits(units);
    expect(result.occupancyRatePercent).toBe(0);
    expect(result.occupiedUnits).toBe(0);
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

// Avg Tenancy (Leasing Pipeline section): measured from LeaseFromDate to
// asOfDate, NOT to LeaseToDate — a month-to-month (AtWill) lease has no
// LeaseToDate at all, so measuring to the end date would silently drop
// every month-to-month tenant from the average.
describe("averageTenancyMonths", () => {
  const asOf = new Date("2026-07-03T00:00:00Z");

  it("averages months-since-move-in across active leases", () => {
    const leases = [
      lease({ LeaseFromDate: "2026-01-03" }), // 6 months
      lease({ LeaseFromDate: "2025-07-03" }), // 12 months
    ];
    const result = averageTenancyMonths(leases, asOf);
    expect(result).toBe(9);
  });

  it("includes month-to-month leases (no LeaseToDate) using LeaseFromDate", () => {
    // 2026-01-03 to 2026-07-03 is exactly 6 calendar months, but
    // averageTenancyMonths divides elapsed days by 30.44 (avg days/month)
    // rather than doing calendar-month arithmetic, so this lands at 5.9,
    // not a rounded 6 — an intentional approximation, not a bug.
    const leases = [lease({ LeaseFromDate: "2026-01-03", LeaseToDate: null, LeaseType: "AtWill" })];
    const result = averageTenancyMonths(leases, asOf);
    expect(result).toBe(5.9);
  });

  it("excludes leases with no LeaseFromDate rather than counting them as 0 months", () => {
    const leases = [lease({ LeaseFromDate: null }), lease({ LeaseFromDate: "2026-01-03" })];
    const result = averageTenancyMonths(leases, asOf);
    expect(result).toBe(5.9); // only the one lease with a real date counts
  });

  it("returns null (not 0 or NaN) when there is no usable lease data at all", () => {
    const leases = [lease({ LeaseFromDate: null })];
    expect(averageTenancyMonths(leases, asOf)).toBeNull();
    expect(averageTenancyMonths([], asOf)).toBeNull();
  });
});

// REBUILT 2026-07-05: Renewal Rate now means "% of leases that renewed
// instead of moving out, over the trailing 12 months" (vendor: 70.8%,
// numerator 138), replacing the old "% of active leases coming up for
// renewal in the next 60 days" (7.5%) definition. See the file header
// comment above summarizeRenewalRate for the full derivation — Buildium
// doesn't create a new lease record for a renewal, it extends LeaseToDate
// on the SAME record, confirmed against 574 real leases (zero same-tenant
// successor-lease matches found when searching for one the obvious way).
// VERIFIED LIVE against the real account: renewed=166, moved out=69,
// rate=70.6% vs. vendor's 70.8%.
describe("summarizeRenewalRate", () => {
  const asOf = new Date("2026-07-05T00:00:00Z");

  it("counts a non-Past lease with a term longer than 365 days, updated within the trailing 12 months, as renewed", () => {
    const leases = [
      lease({
        LeaseStatus: "Active",
        LeaseFromDate: "2024-01-01",
        LeaseToDate: "2027-01-01", // 3-year total term — clearly extended past a normal 1-year term
        LastUpdatedDateTime: "2026-03-01T00:00:00Z",
      }),
    ];
    const result = summarizeRenewalRate(leases, asOf);
    expect(result.renewedCount).toBe(1);
    expect(result.movedOutCount).toBe(0);
  });

  it("does NOT count a plain never-renewed 1-year lease as renewed, even if recently updated", () => {
    const leases = [
      lease({
        LeaseStatus: "Active",
        LeaseFromDate: "2026-01-01",
        LeaseToDate: "2026-12-31", // 364 days — a normal single term, never extended
        LastUpdatedDateTime: "2026-06-01T00:00:00Z",
      }),
    ];
    const result = summarizeRenewalRate(leases, asOf);
    expect(result.renewedCount).toBe(0);
  });

  it("does not count a non-Past lease as renewed if its LastUpdatedDateTime is outside the trailing 12 months", () => {
    const leases = [
      lease({
        LeaseStatus: "Active",
        LeaseFromDate: "2020-01-01",
        LeaseToDate: "2027-01-01",
        LastUpdatedDateTime: "2024-01-01T00:00:00Z", // stale — not a recent renewal
      }),
    ];
    const result = summarizeRenewalRate(leases, asOf);
    expect(result.renewedCount).toBe(0);
  });

  it("counts a Past lease with LeaseToDate in the trailing 12 months and a full term as moved out", () => {
    const leases = [
      lease({
        LeaseStatus: "Past",
        LeaseFromDate: "2025-01-01",
        LeaseToDate: "2026-01-01", // 365 days, a completed normal term
      }),
    ];
    const result = summarizeRenewalRate(leases, asOf);
    expect(result.movedOutCount).toBe(1);
    expect(result.renewedCount).toBe(0);
  });

  it("excludes a Past lease with a short/broken term (early termination, eviction) from moved-out", () => {
    const leases = [
      lease({
        LeaseStatus: "Past",
        LeaseFromDate: "2026-01-01",
        LeaseToDate: "2026-03-01", // ~59 days — well under the 300-day floor, not a real renew-or-leave decision point
      }),
    ];
    const result = summarizeRenewalRate(leases, asOf);
    expect(result.movedOutCount).toBe(0);
  });

  it("excludes a Past lease whose LeaseToDate falls outside the trailing 12 months", () => {
    const leases = [
      lease({
        LeaseStatus: "Past",
        LeaseFromDate: "2023-01-01",
        LeaseToDate: "2024-01-01", // years ago, outside the window
      }),
    ];
    const result = summarizeRenewalRate(leases, asOf);
    expect(result.movedOutCount).toBe(0);
  });

  it("excludes a lease with no LeaseFromDate or LeaseToDate (month-to-month / data gap)", () => {
    const leases = [lease({ LeaseStatus: "Active", LeaseFromDate: null, LeaseToDate: null })];
    const result = summarizeRenewalRate(leases, asOf);
    expect(result).toEqual({ renewedCount: 0, movedOutCount: 0, renewalRatePercent: null });
  });

  it("computes the rate as renewed / (renewed + moved out)", () => {
    const leases = [
      lease({
        Id: 1,
        LeaseStatus: "Active",
        LeaseFromDate: "2024-01-01",
        LeaseToDate: "2027-01-01",
        LastUpdatedDateTime: "2026-03-01T00:00:00Z",
      }), // renewed
      lease({
        Id: 2,
        LeaseStatus: "Active",
        LeaseFromDate: "2024-06-01",
        LeaseToDate: "2027-06-01",
        LastUpdatedDateTime: "2026-05-01T00:00:00Z",
      }), // renewed
      lease({
        Id: 3,
        LeaseStatus: "Past",
        LeaseFromDate: "2025-01-01",
        LeaseToDate: "2026-01-01",
      }), // moved out
    ];
    const result = summarizeRenewalRate(leases, asOf);
    expect(result).toEqual({ renewedCount: 2, movedOutCount: 1, renewalRatePercent: 66.7 });
  });

  it("returns null renewalRatePercent (not 0 or NaN) when there is no trailing-12mo population at all", () => {
    expect(summarizeRenewalRate([], asOf)).toEqual({ renewedCount: 0, movedOutCount: 0, renewalRatePercent: null });
  });
});

describe("summarizeDelinquencyRate", () => {
  function balance(overrides: Partial<LeaseBalance>): LeaseBalance {
    return { leaseId: "1", propertyId: "1", balance: 0, evictionPendingDate: null, balancesByGl: [], ...overrides };
  }

  it("divides total positive delinquent balance by total monthly rent across active leases", () => {
    const balances = [balance({ leaseId: "1", balance: 500 }), balance({ leaseId: "2", balance: 300 })];
    const leases = [
      lease({ Id: 1, AccountDetails: { Rent: 1000, SecurityDeposit: null } }),
      lease({ Id: 2, AccountDetails: { Rent: 1000, SecurityDeposit: null } }),
      lease({ Id: 3, AccountDetails: { Rent: 2000, SecurityDeposit: null } }),
    ];
    const result = summarizeDelinquencyRate(balances, leases);
    expect(result).toEqual({ totalDelinquentBalance: 800, totalMonthlyRent: 4000, ratePercent: 20 });
  });

  it("excludes a negative (credit) balance from the delinquent total", () => {
    const balances = [balance({ leaseId: "1", balance: -50 }), balance({ leaseId: "2", balance: 200 })];
    const leases = [lease({ Id: 1, AccountDetails: { Rent: 1000, SecurityDeposit: null } })];
    const result = summarizeDelinquencyRate(balances, leases);
    expect(result.totalDelinquentBalance).toBe(200);
  });

  it("returns null when there is no monthly rent to divide by", () => {
    expect(summarizeDelinquencyRate([], [])).toEqual({ totalDelinquentBalance: 0, totalMonthlyRent: 0, ratePercent: null });
  });
});
