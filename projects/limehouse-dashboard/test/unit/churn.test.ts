import { describe, it, expect } from "vitest";
import {
  buildPropertyManagementStarts,
  summarizeDoorsAdded,
  estimatePropertyLossDates,
  summarizeDoorsLostEstimate,
  summarizeNetDoorsYTD,
  summarizeTotalUnitsYoY,
  netDoorsRows,
} from "../../src/kpi/churn.js";
import type { BuildiumOwner, BuildiumProperty, BuildiumLease } from "../../src/buildium/client.js";

function owner(overrides: Partial<BuildiumOwner>): BuildiumOwner {
  return {
    Id: 1,
    FirstName: "Jane",
    LastName: "Doe",
    IsCompany: false,
    CompanyName: null,
    Email: null,
    ManagementAgreementStartDate: null,
    ManagementAgreementEndDate: null,
    PropertyIds: null,
    ...overrides,
  };
}

function inactiveProperty(overrides: Partial<BuildiumProperty>): BuildiumProperty {
  return {
    Id: 1,
    Name: "Test Property",
    IsActive: false,
    RentalType: "Residential",
    NumberUnits: 1,
    Address: { AddressLine1: "1 Main St", AddressLine2: null, City: "Norfolk", State: "VA", PostalCode: "23500" },
    RentalManager: null,
    ...overrides,
  };
}

function lease(overrides: Partial<BuildiumLease>): BuildiumLease {
  return {
    Id: 1,
    PropertyId: 1,
    UnitId: 1,
    UnitNumber: "1A",
    LeaseStatus: "Past",
    LeaseType: "Fixed",
    LeaseFromDate: "2024-01-01",
    LeaseToDate: "2024-12-31",
    IsEvictionPending: false,
    PaymentDueDay: 1,
    CurrentTenants: null,
    ...overrides,
  };
}

describe("buildPropertyManagementStarts", () => {
  it("uses a single owner's start date directly", () => {
    const owners = [owner({ ManagementAgreementStartDate: "2026-05-01", PropertyIds: [100] })];
    const result = buildPropertyManagementStarts(owners, new Set(["100"]), []);
    expect(result.properties).toEqual([{ propertyId: "100", earliestStartDate: "2026-05-01" }]);
    expect(result.flaggedDisagreements).toEqual([]);
  });

  it("uses the EARLIEST date across co-owners, not the latest or first-seen", () => {
    const owners = [
      owner({ Id: 1, ManagementAgreementStartDate: "2024-01-01", PropertyIds: [200] }),
      owner({ Id: 2, ManagementAgreementStartDate: "2020-01-01", PropertyIds: [200] }), // earlier, added second
    ];
    const result = buildPropertyManagementStarts(owners, new Set(["200"]), []);
    expect(result.properties).toEqual([{ propertyId: "200", earliestStartDate: "2020-01-01" }]);
  });

  it("flags a co-owner disagreement over 30 days, with earliest/latest/diff reported", () => {
    const owners = [
      owner({ Id: 1, ManagementAgreementStartDate: "2021-11-23", PropertyIds: [300] }),
      owner({ Id: 2, ManagementAgreementStartDate: "2024-12-03", PropertyIds: [300] }), // ~1106 days later, matches a real case found live
    ];
    const result = buildPropertyManagementStarts(owners, new Set(["300"]), []);
    expect(result.flaggedDisagreements).toEqual([
      { propertyId: "300", earliestStartDate: "2021-11-23", latestStartDate: "2024-12-03", diffDays: 1106 },
    ]);
  });

  it("does NOT flag a co-owner disagreement of 30 days or less", () => {
    const owners = [
      owner({ Id: 1, ManagementAgreementStartDate: "2026-01-01", PropertyIds: [400] }),
      owner({ Id: 2, ManagementAgreementStartDate: "2026-01-20", PropertyIds: [400] }), // 19 days apart
    ];
    const result = buildPropertyManagementStarts(owners, new Set(["400"]), []);
    expect(result.flaggedDisagreements).toEqual([]);
  });

  it("ignores an owner record with a null start date entirely rather than treating it as a disagreement", () => {
    const owners = [
      owner({ Id: 1, ManagementAgreementStartDate: "2026-01-01", PropertyIds: [500] }),
      owner({ Id: 2, ManagementAgreementStartDate: null, PropertyIds: [500] }),
    ];
    const result = buildPropertyManagementStarts(owners, new Set(["500"]), []);
    expect(result.properties).toEqual([{ propertyId: "500", earliestStartDate: "2026-01-01" }]);
    expect(result.flaggedDisagreements).toEqual([]);
  });

  it("excludes a property not in the active-property set", () => {
    const owners = [owner({ ManagementAgreementStartDate: "2026-01-01", PropertyIds: [999] })];
    const result = buildPropertyManagementStarts(owners, new Set(["100"]), []); // 999 not active
    expect(result.properties).toEqual([]);
  });

  it("handles an owner with no PropertyIds at all (null) without throwing", () => {
    const owners = [owner({ ManagementAgreementStartDate: "2026-01-01", PropertyIds: null })];
    const result = buildPropertyManagementStarts(owners, new Set(["100"]), []);
    expect(result.properties).toEqual([]);
  });

  it("attributes one owner's start date to every property they co-own", () => {
    const owners = [owner({ ManagementAgreementStartDate: "2026-01-01", PropertyIds: [1, 2, 3] })];
    const result = buildPropertyManagementStarts(owners, new Set(["1", "2", "3"]), []);
    expect(result.properties.map((p) => p.propertyId).sort()).toEqual(["1", "2", "3"]);
  });

  it("uses the earliest LEASE date as a floor when it's earlier than the management agreement date (re-signed agreement masking a long-standing door)", () => {
    // Matches the real confirmed case: 1309 Sierra Drive — agreement re-signed
    // 2026-01-01 but the earliest real lease started 2023-01-10.
    const owners = [owner({ ManagementAgreementStartDate: "2026-01-01", PropertyIds: [600] })];
    const leases = [
      lease({ PropertyId: 600, LeaseFromDate: "2023-01-10" }),
      lease({ PropertyId: 600, LeaseFromDate: "2024-05-01" }),
    ];
    const result = buildPropertyManagementStarts(owners, new Set(["600"]), leases);
    expect(result.properties).toEqual([{ propertyId: "600", earliestStartDate: "2023-01-10" }]);
  });

  it("keeps the management agreement date when it's earlier than any lease on file", () => {
    const owners = [owner({ ManagementAgreementStartDate: "2020-01-01", PropertyIds: [700] })];
    const leases = [lease({ PropertyId: 700, LeaseFromDate: "2021-06-01" })];
    const result = buildPropertyManagementStarts(owners, new Set(["700"]), leases);
    expect(result.properties).toEqual([{ propertyId: "700", earliestStartDate: "2020-01-01" }]);
  });

  it("ignores leases belonging to a different property when computing the floor", () => {
    const owners = [owner({ ManagementAgreementStartDate: "2026-01-01", PropertyIds: [800] })];
    const leases = [lease({ PropertyId: 999, LeaseFromDate: "2019-01-01" })]; // different property, must not leak in
    const result = buildPropertyManagementStarts(owners, new Set(["800"]), leases);
    expect(result.properties).toEqual([{ propertyId: "800", earliestStartDate: "2026-01-01" }]);
  });
});

// Verified live against Jason's real account 2026-07-03: 5 doors added in
// the last 30 days, 11 in 60, 17 in 90 (as of "today" = 2026-07-03).
describe("summarizeDoorsAdded", () => {
  const asOf = new Date("2026-07-03T00:00:00Z");

  it("counts a property once in every window its start date falls within (30/60/90/365 are cumulative, not exclusive buckets)", () => {
    const properties = [
      { propertyId: "1", earliestStartDate: "2026-06-20" }, // 13 days ago: in all four windows
      { propertyId: "2", earliestStartDate: "2026-05-20" }, // 44 days ago: in 60/90/365
      { propertyId: "3", earliestStartDate: "2026-04-20" }, // 74 days ago: in 90/365
      { propertyId: "4", earliestStartDate: "2026-01-01" }, // 183 days ago: in 365 only
      { propertyId: "5", earliestStartDate: "2024-01-01" }, // way outside all four
    ];
    const result = summarizeDoorsAdded(properties, asOf);
    expect(result).toEqual({
      doorsAdded30Days: 1,
      doorsAdded60Days: 2,
      doorsAdded90Days: 3,
      doorsAdded365Days: 4,
      doorsAddedYTD: 4, // properties 1-4 all have earliestStartDate >= 2026-01-01; property 5 (2024) doesn't
    });
  });

  it("does not count a start date in the future toward the trailing 30/60/90/365 windows", () => {
    const properties = [{ propertyId: "1", earliestStartDate: "2026-08-01" }];
    const result = summarizeDoorsAdded(properties, asOf);
    expect(result.doorsAdded30Days).toBe(0);
    expect(result.doorsAdded60Days).toBe(0);
    expect(result.doorsAdded90Days).toBe(0);
    expect(result.doorsAdded365Days).toBe(0);
  });

  // CHANGED 2026-07-07: a near-future agreement date within the CURRENT
  // calendar year still counts toward YTD, even though it hasn't happened
  // yet relative to the trailing windows above. Matches the real case: 1342
  // Little Bay Ave, agreement dated 2026-07-10, which was being silently
  // dropped from Doors Added YTD before this fix.
  it("DOES count a future start date toward YTD as long as it's within the current calendar year", () => {
    const properties = [{ propertyId: "1", earliestStartDate: "2026-08-01" }];
    const result = summarizeDoorsAdded(properties, asOf);
    expect(result.doorsAddedYTD).toBe(1);
  });

  it("does not count a future start date toward YTD when it falls in a later calendar year", () => {
    const properties = [{ propertyId: "1", earliestStartDate: "2027-01-01" }];
    const result = summarizeDoorsAdded(properties, asOf);
    expect(result.doorsAddedYTD).toBe(0);
  });

  it("counts a start date exactly on the boundary (30 days ago) as included", () => {
    const properties = [{ propertyId: "1", earliestStartDate: "2026-06-03" }]; // exactly 30 days before 2026-07-03
    const result = summarizeDoorsAdded(properties, asOf);
    expect(result.doorsAdded30Days).toBe(1);
  });

  it("returns all zeros for an empty property list", () => {
    expect(summarizeDoorsAdded([], asOf)).toEqual({
      doorsAdded30Days: 0,
      doorsAdded60Days: 0,
      doorsAdded90Days: 0,
      doorsAdded365Days: 0,
      doorsAddedYTD: 0,
    });
  });

  it("counts a start date exactly on Jan 1 of the current year as YTD (boundary inclusive)", () => {
    const properties = [{ propertyId: "1", earliestStartDate: "2026-01-01" }];
    expect(summarizeDoorsAdded(properties, asOf).doorsAddedYTD).toBe(1);
  });

  it("excludes a start date from last calendar year from YTD, even if within the trailing 365 days", () => {
    const properties = [{ propertyId: "1", earliestStartDate: "2025-12-15" }]; // within 365 days of asOf, but last calendar year
    const result = summarizeDoorsAdded(properties, asOf);
    expect(result.doorsAdded365Days).toBe(1);
    expect(result.doorsAddedYTD).toBe(0);
  });
});

// Doors Lost (ESTIMATED) — proxy confirmed by Oracle: for a currently
// IsActive:false property, the most recent LeaseToDate across its leases
// approximates the loss date. Verified live for the real account: 2 doors
// lost in the last 31 days, 26 in the last 12 months.
describe("estimatePropertyLossDates", () => {
  it("uses the MOST RECENT LeaseToDate across a property's leases as the estimated loss date", () => {
    const properties = [inactiveProperty({ Id: 1 })];
    const leases = [
      lease({ PropertyId: 1, UnitId: 1, LeaseToDate: "2024-06-01" }),
      lease({ PropertyId: 1, UnitId: 1, LeaseToDate: "2025-01-15" }), // more recent — this one wins
    ];
    const result = estimatePropertyLossDates(properties, leases);
    expect(result).toEqual([{ propertyId: "1", estimatedLossDate: "2025-01-15" }]);
  });

  it("only considers leases belonging to the property in question", () => {
    const properties = [inactiveProperty({ Id: 1 })];
    const leases = [
      lease({ PropertyId: 1, LeaseToDate: "2024-06-01" }),
      lease({ PropertyId: 2, LeaseToDate: "2026-01-01" }), // a different property's much-later lease must not leak in
    ];
    const result = estimatePropertyLossDates(properties, leases);
    expect(result).toEqual([{ propertyId: "1", estimatedLossDate: "2024-06-01" }]);
  });

  it("excludes a property with no lease records at all (the documented undercount) rather than guessing", () => {
    const properties = [inactiveProperty({ Id: 1 }), inactiveProperty({ Id: 2 })];
    const leases = [lease({ PropertyId: 1, LeaseToDate: "2024-06-01" })]; // property 2 has none
    const result = estimatePropertyLossDates(properties, leases);
    expect(result).toEqual([{ propertyId: "1", estimatedLossDate: "2024-06-01" }]);
  });

  it("ignores a lease with no LeaseToDate (month-to-month, still technically open-ended)", () => {
    const properties = [inactiveProperty({ Id: 1 })];
    const leases = [
      lease({ PropertyId: 1, LeaseToDate: null }),
      lease({ PropertyId: 1, LeaseToDate: "2024-03-01" }),
    ];
    const result = estimatePropertyLossDates(properties, leases);
    expect(result).toEqual([{ propertyId: "1", estimatedLossDate: "2024-03-01" }]);
  });

  it("returns an empty array when there are no inactive properties", () => {
    expect(estimatePropertyLossDates([], [lease({})])).toEqual([]);
  });
});

describe("summarizeDoorsLostEstimate", () => {
  const asOf = new Date("2026-07-03T00:00:00Z");

  it("counts estimates within 31 days and within 12 months, cumulative not exclusive", () => {
    const estimates = [
      { propertyId: "1", estimatedLossDate: "2026-06-15" }, // 18 days ago: in both windows
      { propertyId: "2", estimatedLossDate: "2026-01-01" }, // ~183 days ago: in 12mo only
      { propertyId: "3", estimatedLossDate: "2024-01-01" }, // way outside both
    ];
    const result = summarizeDoorsLostEstimate(estimates, 5, asOf);
    expect(result.doorsLost31Days).toBe(1);
    expect(result.doorsLost12Months).toBe(2);
  });

  it("reports propertiesUndercounted as the gap between total inactive properties and estimates produced", () => {
    const estimates = [{ propertyId: "1", estimatedLossDate: "2026-06-15" }];
    // 5 total inactive properties, but only 1 had a derivable estimate —
    // the other 4 had no lease records at all (the documented undercount).
    const result = summarizeDoorsLostEstimate(estimates, 5, asOf);
    expect(result.propertiesUndercounted).toBe(4);
  });

  it("does not count an estimated loss date in the future as a loss yet", () => {
    const estimates = [{ propertyId: "1", estimatedLossDate: "2026-08-01" }];
    const result = summarizeDoorsLostEstimate(estimates, 1, asOf);
    expect(result.doorsLost31Days).toBe(0);
    expect(result.doorsLost12Months).toBe(0);
  });

  it("returns all zeros and full undercount for no estimates at all", () => {
    const result = summarizeDoorsLostEstimate([], 3, asOf);
    expect(result).toEqual({ doorsLost31Days: 0, doorsLost12Months: 0, propertiesUndercounted: 3, doorsLostYTD: 0 });
  });

  it("counts an estimated loss date this calendar year toward doorsLostYTD, excluding one from last year even if within the trailing 12 months", () => {
    const estimates = [
      { propertyId: "1", estimatedLossDate: "2026-02-01" }, // this year
      { propertyId: "2", estimatedLossDate: "2025-12-01" }, // last year, within 365 days of asOf
    ];
    const result = summarizeDoorsLostEstimate(estimates, 2, asOf);
    expect(result.doorsLostYTD).toBe(1);
  });
});

// ADDED 2026-07-07: Net Doors as an EXACT year-to-date figure, using
// Jason's own real door counts (units under management) as of Jan 1 each
// year — see the file header comment on DOOR_COUNT_ANCHORS_BY_YEAR for why
// (the vendor's own "trailing 12 months" Net Doors tile is really only a
// ~50-day daily-snapshot diff per its own drill-down note, so it isn't a
// meaningful target to reproduce).
describe("summarizeNetDoorsYTD", () => {
  it("computes net doors as current total minus the door count at the start of this year", () => {
    const asOf = new Date("2026-07-07T00:00:00Z");
    const result = summarizeNetDoorsYTD(234, asOf); // real anchor for 2026 is 218
    expect(result).toEqual({ netDoors: 16, sinceDate: "2026-01-01", doorsAtStartOfYear: 218, currentTotalDoors: 234 });
  });

  it("returns a negative netDoors when the current total is below the year's starting count", () => {
    const asOf = new Date("2025-06-01T00:00:00Z");
    const result = summarizeNetDoorsYTD(200, asOf); // real anchor for 2025 is 222
    expect(result?.netDoors).toBe(-22);
  });

  it("returns null when there's no known anchor for asOfDate's year", () => {
    const asOf = new Date("2030-01-01T00:00:00Z");
    expect(summarizeNetDoorsYTD(300, asOf)).toBeNull();
  });
});

// ADDED 2026-07-09, per Jason directly: the vendor's own "Total Units"
// tile shows a "+143.8% vs last yr" badge, but that figure doesn't
// reconcile against any of Jason's real Jan-1 anchors (implies a ~96-unit
// baseline that was never real) — same kind of broken historical tracking
// as the vendor's own admitted ~50-day-old Net Doors snapshot. Jason chose
// to reuse the Jan 1 THIS YEAR anchor (same one Net Doors YTD already
// uses) rather than guess at the vendor's baseline.
describe("summarizeTotalUnitsYoY", () => {
  it("computes percent change from the door count at the start of this year", () => {
    const asOf = new Date("2026-07-09T00:00:00Z");
    const result = summarizeTotalUnitsYoY(234, asOf); // real anchor for 2026 is 218
    expect(result).toEqual({ percent: 7.3, direction: "up", anchorUnits: 218, anchorDate: "2026-01-01" });
  });

  it("returns direction:down and a negative percent when below the year's starting count", () => {
    const asOf = new Date("2025-06-01T00:00:00Z");
    const result = summarizeTotalUnitsYoY(200, asOf); // real anchor for 2025 is 222
    expect(result?.direction).toBe("down");
    expect(result?.percent).toBeLessThan(0);
  });

  it("returns null when there's no known anchor for asOfDate's year", () => {
    const asOf = new Date("2030-01-01T00:00:00Z");
    expect(summarizeTotalUnitsYoY(300, asOf)).toBeNull();
  });
});

// FIXED 2026-07-05: this used to be inlined in the /api/dashboard/net-doors/
// properties route with two bugs — no lower bound on days-ago (a FUTURE
// start/loss date counted as already happened) and mismatched windows
// (added=90d, lost=365d). CONFIRMED LIVE: property 701423 had a
// ManagementAgreementStartDate of 2026-07-10, in the future relative to
// "today" at the time this was found — it must NOT appear in the "added"
// rows below.
describe("netDoorsRows", () => {
  const asOf = new Date("2026-07-05T00:00:00Z");

  it("includes an added property within the trailing 12 months and a lost property within the trailing 12 months", () => {
    const properties = [{ propertyId: "1", earliestStartDate: "2026-06-01" }]; // 34 days ago
    const lossEstimates = [{ propertyId: "2", estimatedLossDate: "2026-01-01" }]; // 185 days ago
    const rows = netDoorsRows(properties, lossEstimates, asOf);
    expect(rows).toEqual([
      { propertyId: "1", type: "added", date: "2026-06-01" },
      { propertyId: "2", type: "lost", date: "2026-01-01" },
    ]);
  });

  it("excludes a property with a FUTURE start date from 'added' rather than counting it as already added", () => {
    // Matches the real case found live: property 701423, start date
    // 2026-07-10, in the future relative to asOf (2026-07-05).
    const properties = [{ propertyId: "701423", earliestStartDate: "2026-07-10" }];
    const rows = netDoorsRows(properties, [], asOf);
    expect(rows).toEqual([]);
  });

  it("excludes a property with a FUTURE estimated loss date from 'lost' (defensive, same bug class)", () => {
    const lossEstimates = [{ propertyId: "1", estimatedLossDate: "2026-07-20" }];
    const rows = netDoorsRows([], lossEstimates, asOf);
    expect(rows).toEqual([]);
  });

  it("excludes an added property older than 12 months (365 days)", () => {
    const properties = [{ propertyId: "1", earliestStartDate: "2024-01-01" }]; // well over 365 days ago
    const rows = netDoorsRows(properties, [], asOf);
    expect(rows).toEqual([]);
  });

  it("excludes a lost property older than 12 months, matching the added side's window", () => {
    const lossEstimates = [{ propertyId: "1", estimatedLossDate: "2024-01-01" }];
    const rows = netDoorsRows([], lossEstimates, asOf);
    expect(rows).toEqual([]);
  });

  it("sorts combined rows by date, most recent first", () => {
    const properties = [{ propertyId: "1", earliestStartDate: "2026-05-01" }];
    const lossEstimates = [{ propertyId: "2", estimatedLossDate: "2026-06-01" }];
    const rows = netDoorsRows(properties, lossEstimates, asOf);
    expect(rows.map((r) => r.propertyId)).toEqual(["2", "1"]);
  });
});
