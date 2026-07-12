import { describe, it, expect } from "vitest";
import {
  summarizeOccupancy,
  summarizeOccupancyFromUnits,
  summarizeLeaseMix,
  upcomingRenewals,
  averageTenancyMonths,
  summarizeRenewalRate,
  mostRecentRentEffectiveDate,
  summarizeDelinquencyRate,
  earliestTrackableMonth,
  summarizeMonthlyOccupancy,
  monthsSinceEarliestTrackable,
  summarizeYearlyOccupancy,
  findSameMonthLastYearOccupancy,
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
    MoveOutData: [],
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
    IsUnitListed: false,
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
describe("mostRecentRentEffectiveDate", () => {
  it("returns the FirstOccurrenceDate of the Rent (GL account 3) line", () => {
    expect(
      mostRecentRentEffectiveDate([
        { firstOccurrenceDate: "2025-08-01", lineGlAccountIds: [3] },
        { firstOccurrenceDate: "2025-08-01", lineGlAccountIds: [958019] }, // Resident Benefits Package fee, not rent
      ])
    ).toBe("2025-08-01");
  });

  it("picks the LATEST Rent entry when a lease has more than one on file (e.g. a future rent increase already scheduled)", () => {
    expect(
      mostRecentRentEffectiveDate([
        { firstOccurrenceDate: "2025-08-01", lineGlAccountIds: [3] },
        { firstOccurrenceDate: "2026-08-01", lineGlAccountIds: [3] },
      ])
    ).toBe("2026-08-01");
  });

  it("returns null when there is no Rent (GL account 3) line at all", () => {
    expect(mostRecentRentEffectiveDate([{ firstOccurrenceDate: "2025-08-01", lineGlAccountIds: [55] }])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(mostRecentRentEffectiveDate([])).toBeNull();
  });
});

describe("summarizeRenewalRate", () => {
  const asOf = new Date("2026-07-05T00:00:00Z");

  it("counts a non-Past lease as renewed when its Rent effective date falls within the trailing 12 months", () => {
    const leases = [lease({ Id: 1, LeaseStatus: "Active", LeaseFromDate: "2024-01-01" })];
    const rentDates = new Map([["1", "2026-03-01"]]);
    const result = summarizeRenewalRate(leases, rentDates, asOf);
    expect(result.renewedCount).toBe(1);
    expect(result.movedOutCount).toBe(0);
  });

  it("does not count a non-Past lease as renewed if it has no Rent effective date on file", () => {
    const leases = [lease({ Id: 1, LeaseStatus: "Active" })];
    const result = summarizeRenewalRate(leases, new Map(), asOf);
    expect(result.renewedCount).toBe(0);
  });

  // CONFIRMED LIVE 2026-07-07: without this guard, a brand-new lease's very
  // first rent charge (dated to move-in, not a renewal) was counted as
  // renewed too — inflated renewedCount to 173 across the real portfolio
  // vs. the vendor's real 138.
  it("does not count a lease as renewed when its Rent effective date is just the original move-in charge, not a later change", () => {
    const leases = [lease({ Id: 1, LeaseStatus: "Active", LeaseFromDate: "2026-03-01" })];
    const rentDates = new Map([["1", "2026-03-01"]]); // same date as LeaseFromDate — day one, not a renewal
    const result = summarizeRenewalRate(leases, rentDates, asOf);
    expect(result.renewedCount).toBe(0);
  });

  // CONFIRMED LIVE 2026-07-07: a mid-month move-in's recurring Rent entry
  // is often dated to the start of the FOLLOWING month (the partial first
  // month gets billed as a one-time proration instead) — a ~15-day gap
  // that's still just day-one setup, not a renewal 6-12 months later.
  it("does not count a lease as renewed when its Rent effective date is only a couple weeks after move-in (proration, not a renewal)", () => {
    const leases = [lease({ Id: 1, LeaseStatus: "Active", LeaseFromDate: "2026-08-17" })];
    const rentDates = new Map([["1", "2026-09-01"]]); // 15 days later — first full month, not a renewal
    const result = summarizeRenewalRate(leases, rentDates, asOf);
    expect(result.renewedCount).toBe(0);
  });

  it("does not count a non-Past lease as renewed if its Rent effective date is more than 12 months stale", () => {
    const leases = [lease({ Id: 1, LeaseStatus: "Active", LeaseFromDate: "2020-01-01" })];
    const rentDates = new Map([["1", "2024-01-01"]]); // stale — not a recent renewal
    const result = summarizeRenewalRate(leases, rentDates, asOf);
    expect(result.renewedCount).toBe(0);
  });

  // CONFIRMED LIVE 2026-07-07: the vendor counts an already-scheduled
  // future rent increase as this year's renewal (properties routinely have
  // next year's rent entered 2-3 months ahead of its effective date). All
  // 35 real leases missing from our list vs. the vendor's real 138 had a
  // future-dated rent effective date we were wrongly excluding.
  it("counts a non-Past lease as renewed even when its Rent effective date is in the future (already scheduled ahead of time)", () => {
    const leases = [lease({ Id: 1, LeaseStatus: "Active", LeaseFromDate: "2024-01-01" })];
    const rentDates = new Map([["1", "2026-09-01"]]); // after asOf (2026-07-05) — scheduled ahead
    const result = summarizeRenewalRate(leases, rentDates, asOf);
    expect(result.renewedCount).toBe(1);
  });

  it("counts a Past lease with LeaseToDate in the trailing 12 months and a full term as moved out", () => {
    const leases = [
      lease({
        LeaseStatus: "Past",
        LeaseFromDate: "2025-01-01",
        LeaseToDate: "2026-01-01", // 365 days, a completed normal term
      }),
    ];
    const result = summarizeRenewalRate(leases, new Map(), asOf);
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
    const result = summarizeRenewalRate(leases, new Map(), asOf);
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
    const result = summarizeRenewalRate(leases, new Map(), asOf);
    expect(result.movedOutCount).toBe(0);
  });

  it("excludes a Past lease with no LeaseFromDate or LeaseToDate (data gap)", () => {
    const leases = [lease({ LeaseStatus: "Past", LeaseFromDate: null, LeaseToDate: null })];
    const result = summarizeRenewalRate(leases, new Map(), asOf);
    expect(result).toEqual({ renewedCount: 0, movedOutCount: 0, renewalRatePercent: null });
  });

  it("computes the rate as renewed / (renewed + moved out)", () => {
    const leases = [
      lease({ Id: 1, LeaseStatus: "Active", LeaseFromDate: "2024-01-01" }), // renewed
      lease({ Id: 2, LeaseStatus: "Active", LeaseFromDate: "2024-01-01" }), // renewed
      lease({
        Id: 3,
        LeaseStatus: "Past",
        LeaseFromDate: "2025-01-01",
        LeaseToDate: "2026-01-01",
      }), // moved out
    ];
    const rentDates = new Map([
      ["1", "2026-03-01"],
      ["2", "2026-05-01"],
    ]);
    const result = summarizeRenewalRate(leases, rentDates, asOf);
    expect(result).toEqual({ renewedCount: 2, movedOutCount: 1, renewalRatePercent: 66.7 });
  });

  it("returns null renewalRatePercent (not 0 or NaN) when there is no trailing-12mo population at all", () => {
    expect(summarizeRenewalRate([], new Map(), asOf)).toEqual({ renewedCount: 0, movedOutCount: 0, renewalRatePercent: null });
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
});

// Occupancy Rate — Year over Year — REBUILT 2026-07-09, per Jason
// directly: reconstructs occupancy for each past month from real lease
// coverage, going back as far as real lease history allows.
describe("earliestTrackableMonth", () => {
  it("returns the earliest LeaseFromDate month across the given units' leases", () => {
    const units = [unit({ Id: 10 }), unit({ Id: 20 })];
    const leases = [
      lease({ UnitId: 10, LeaseFromDate: "2020-05-15" }),
      lease({ UnitId: 20, LeaseFromDate: "2018-02-01" }),
    ];
    expect(earliestTrackableMonth(units, leases)).toBe("2018-02");
  });

  it("ignores leases belonging to units outside the given list", () => {
    const units = [unit({ Id: 10 })];
    const leases = [lease({ UnitId: 10, LeaseFromDate: "2020-01-01" }), lease({ UnitId: 999, LeaseFromDate: "2015-01-01" })];
    expect(earliestTrackableMonth(units, leases)).toBe("2020-01");
  });

  it("returns null when none of the units has any lease history", () => {
    expect(earliestTrackableMonth([unit({ Id: 10 })], [])).toBeNull();
  });
});

describe("summarizeMonthlyOccupancy", () => {
  const asOf = new Date("2026-07-09T00:00:00Z");

  it("counts a unit occupied for a month its lease covers (LeaseFromDate before/at month end, LeaseToDate at/after month start)", () => {
    const units = [unit({ Id: 10 })];
    const leases = [lease({ UnitId: 10, LeaseFromDate: "2025-01-01", LeaseToDate: "2025-12-31" })];
    const result = summarizeMonthlyOccupancy(units, leases, ["2025-06"], asOf);
    expect(result).toEqual([{ month: "2025-06", occupiedUnits: 1, totalUnits: 1, occupancyPercent: 100 }]);
  });

  it("counts a unit vacant for a month with no lease covering it, but still in the total", () => {
    const units = [unit({ Id: 10 })];
    const leases = [lease({ UnitId: 10, LeaseFromDate: "2025-01-01", LeaseToDate: "2025-03-31" })];
    const result = summarizeMonthlyOccupancy(units, leases, ["2025-06"], asOf);
    expect(result).toEqual([{ month: "2025-06", occupiedUnits: 0, totalUnits: 1, occupancyPercent: 0 }]);
  });

  it("treats a null LeaseToDate as an ongoing (month-to-month) lease covering every month from its start onward", () => {
    const units = [unit({ Id: 10 })];
    const leases = [lease({ UnitId: 10, LeaseFromDate: "2024-01-01", LeaseToDate: null })];
    const result = summarizeMonthlyOccupancy(units, leases, ["2026-06"], asOf);
    expect(result[0].occupiedUnits).toBe(1);
  });

  it("excludes a unit from the total entirely for a month before its earliest known lease started", () => {
    const units = [unit({ Id: 10 })];
    const leases = [lease({ UnitId: 10, LeaseFromDate: "2025-06-01", LeaseToDate: "2026-05-31" })];
    const result = summarizeMonthlyOccupancy(units, leases, ["2024-01"], asOf);
    expect(result).toEqual([{ month: "2024-01", occupiedUnits: 0, totalUnits: 0, occupancyPercent: null }]);
  });

  // CONFIRMED 2026-07-09, per Jason directly: units with zero lease
  // history are all real, recently-added properties that haven't been
  // rented yet — not decades-old vacancies. They must NOT be projected
  // backward into years they didn't exist.
  it("excludes a unit with zero lease history from every past month", () => {
    const units = [unit({ Id: 10 })]; // never-rented, no lease record
    const result = summarizeMonthlyOccupancy(units, [], ["2020-01"], asOf); // asOf is 2026-07, well after 2020-01
    expect(result).toEqual([{ month: "2020-01", occupiedUnits: 0, totalUnits: 0, occupancyPercent: null }]);
  });

  it("includes a unit with zero lease history only in the CURRENT month (asOf), not before", () => {
    const units = [unit({ Id: 10 })];
    const result = summarizeMonthlyOccupancy(units, [], ["2026-07"], asOf); // asOf's own month
    expect(result).toEqual([{ month: "2026-07", occupiedUnits: 0, totalUnits: 1, occupancyPercent: 0 }]);
  });

  it("computes a portfolio-wide percentage across multiple units in the same month", () => {
    const units = [unit({ Id: 10 }), unit({ Id: 20 }), unit({ Id: 30 })];
    const leases = [
      lease({ UnitId: 10, LeaseFromDate: "2025-01-01", LeaseToDate: "2025-12-31" }), // occupied
      lease({ UnitId: 20, LeaseFromDate: "2024-01-01", LeaseToDate: "2024-12-31" }), // vacant by 2025-06
      // unit 30: no lease at all — only counted because asOf below IS 2025-06
    ];
    const result = summarizeMonthlyOccupancy(units, leases, ["2025-06"], new Date("2025-06-15T00:00:00Z"));
    expect(result[0]).toEqual({ month: "2025-06", occupiedUnits: 1, totalUnits: 3, occupancyPercent: 33.3 });
  });
});

describe("monthsSinceEarliestTrackable", () => {
  it("returns every month from January of the earliest trackable year through asOf's month", () => {
    const asOf = new Date("2026-03-01T00:00:00Z");
    const result = monthsSinceEarliestTrackable(asOf, "2024-07");
    expect(result[0]).toBe("2024-01");
    expect(result[result.length - 1]).toBe("2026-03");
  });
});

describe("summarizeYearlyOccupancy", () => {
  it("rolls monthly figures up as a ratio of sums (occupied unit-months over total unit-months), not an average of percentages", () => {
    const months = [
      { month: "2025-01", occupiedUnits: 1, totalUnits: 1, occupancyPercent: 100 },
      { month: "2025-02", occupiedUnits: 1, totalUnits: 10, occupancyPercent: 10 },
    ];
    const result = summarizeYearlyOccupancy(months);
    // naive average of percentages would be 55%; ratio of sums is 2/11 = 18.2%
    expect(result[0].avgOccupancyPercent).toBe(18.2);
    expect(result[0].year).toBe("2025");
    expect(result[0].lastMonth).toBe("2025-02");
  });

  it("sorts most recent year first", () => {
    const months = [
      { month: "2023-06", occupiedUnits: 1, totalUnits: 1, occupancyPercent: 100 },
      { month: "2025-06", occupiedUnits: 1, totalUnits: 1, occupancyPercent: 100 },
      { month: "2024-06", occupiedUnits: 1, totalUnits: 1, occupancyPercent: 100 },
    ];
    expect(summarizeYearlyOccupancy(months).map((y) => y.year)).toEqual(["2025", "2024", "2023"]);
  });
});

describe("findSameMonthLastYearOccupancy", () => {
  it("finds the same calendar month one year earlier", () => {
    const months = [
      { month: "2025-06", occupiedUnits: 8, totalUnits: 10, occupancyPercent: 80 },
      { month: "2026-06", occupiedUnits: 9, totalUnits: 10, occupancyPercent: 90 },
    ];
    const result = findSameMonthLastYearOccupancy(months, "2026-06");
    expect(result).toEqual({ month: "2026-06", lastYearMonth: "2025-06", lastYearOccupancyPercent: 80 });
  });

  it("returns null when last year's same month isn't in the data", () => {
    const months = [{ month: "2026-06", occupiedUnits: 9, totalUnits: 10, occupancyPercent: 90 }];
    expect(findSameMonthLastYearOccupancy(months, "2026-06")).toBeNull();
  });

  it("returns null when there is no monthly rent to divide by", () => {
    expect(summarizeDelinquencyRate([], [])).toEqual({ totalDelinquentBalance: 0, totalMonthlyRent: 0, ratePercent: null });
  });
});
