import { describe, it, expect } from "vitest";
import {
  buildPropertyManagementStarts,
  summarizeDoorsAdded,
  estimatePropertyLossDates,
  summarizeDoorsLostEstimate,
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
    const result = buildPropertyManagementStarts(owners, new Set(["100"]));
    expect(result.properties).toEqual([{ propertyId: "100", earliestStartDate: "2026-05-01" }]);
    expect(result.flaggedDisagreements).toEqual([]);
  });

  it("uses the EARLIEST date across co-owners, not the latest or first-seen", () => {
    const owners = [
      owner({ Id: 1, ManagementAgreementStartDate: "2024-01-01", PropertyIds: [200] }),
      owner({ Id: 2, ManagementAgreementStartDate: "2020-01-01", PropertyIds: [200] }), // earlier, added second
    ];
    const result = buildPropertyManagementStarts(owners, new Set(["200"]));
    expect(result.properties).toEqual([{ propertyId: "200", earliestStartDate: "2020-01-01" }]);
  });

  it("flags a co-owner disagreement over 30 days, with earliest/latest/diff reported", () => {
    const owners = [
      owner({ Id: 1, ManagementAgreementStartDate: "2021-11-23", PropertyIds: [300] }),
      owner({ Id: 2, ManagementAgreementStartDate: "2024-12-03", PropertyIds: [300] }), // ~1106 days later, matches a real case found live
    ];
    const result = buildPropertyManagementStarts(owners, new Set(["300"]));
    expect(result.flaggedDisagreements).toEqual([
      { propertyId: "300", earliestStartDate: "2021-11-23", latestStartDate: "2024-12-03", diffDays: 1106 },
    ]);
  });

  it("does NOT flag a co-owner disagreement of 30 days or less", () => {
    const owners = [
      owner({ Id: 1, ManagementAgreementStartDate: "2026-01-01", PropertyIds: [400] }),
      owner({ Id: 2, ManagementAgreementStartDate: "2026-01-20", PropertyIds: [400] }), // 19 days apart
    ];
    const result = buildPropertyManagementStarts(owners, new Set(["400"]));
    expect(result.flaggedDisagreements).toEqual([]);
  });

  it("ignores an owner record with a null start date entirely rather than treating it as a disagreement", () => {
    const owners = [
      owner({ Id: 1, ManagementAgreementStartDate: "2026-01-01", PropertyIds: [500] }),
      owner({ Id: 2, ManagementAgreementStartDate: null, PropertyIds: [500] }),
    ];
    const result = buildPropertyManagementStarts(owners, new Set(["500"]));
    expect(result.properties).toEqual([{ propertyId: "500", earliestStartDate: "2026-01-01" }]);
    expect(result.flaggedDisagreements).toEqual([]);
  });

  it("excludes a property not in the active-property set", () => {
    const owners = [owner({ ManagementAgreementStartDate: "2026-01-01", PropertyIds: [999] })];
    const result = buildPropertyManagementStarts(owners, new Set(["100"])); // 999 not active
    expect(result.properties).toEqual([]);
  });

  it("handles an owner with no PropertyIds at all (null) without throwing", () => {
    const owners = [owner({ ManagementAgreementStartDate: "2026-01-01", PropertyIds: null })];
    const result = buildPropertyManagementStarts(owners, new Set(["100"]));
    expect(result.properties).toEqual([]);
  });

  it("attributes one owner's start date to every property they co-own", () => {
    const owners = [owner({ ManagementAgreementStartDate: "2026-01-01", PropertyIds: [1, 2, 3] })];
    const result = buildPropertyManagementStarts(owners, new Set(["1", "2", "3"]));
    expect(result.properties.map((p) => p.propertyId).sort()).toEqual(["1", "2", "3"]);
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
    });
  });

  it("does not count a start date in the future as a door added yet", () => {
    const properties = [{ propertyId: "1", earliestStartDate: "2026-08-01" }];
    const result = summarizeDoorsAdded(properties, asOf);
    expect(result).toEqual({ doorsAdded30Days: 0, doorsAdded60Days: 0, doorsAdded90Days: 0, doorsAdded365Days: 0 });
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
    });
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
    expect(result).toEqual({ doorsLost31Days: 0, doorsLost12Months: 0, propertiesUndercounted: 3 });
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
