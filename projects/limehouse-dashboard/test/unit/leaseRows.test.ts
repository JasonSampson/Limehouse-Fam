import { describe, it, expect } from "vitest";
import {
  rentLeaseRows,
  fixedTermLeaseRows,
  monthToMonthLeaseRows,
  evictionPendingLeaseRows,
  tenancyRows,
  moveInLeaseRows,
  unitStatusRows,
  vacantUnitRows,
  vacantUnitDaysRows,
  averageDaysVacant,
  renewalRateRows,
} from "../../src/kpi/leaseRows.js";
import type { BuildiumLease, BuildiumUnit } from "../../src/buildium/client.js";

function lease(overrides: Partial<BuildiumLease>): BuildiumLease {
  return {
    Id: 1,
    PropertyId: 100,
    UnitId: 10,
    UnitNumber: "1",
    LeaseStatus: "Active",
    LeaseType: "Fixed",
    LeaseFromDate: "2025-01-01",
    LeaseToDate: "2025-12-31",
    IsEvictionPending: false,
    PaymentDueDay: 1,
    CurrentTenants: [{ Id: 1, FirstName: "Jane", LastName: "Doe", Email: null }],
    AccountDetails: { Rent: 1500, SecurityDeposit: 1500 },
    ...overrides,
  };
}

function unit(overrides: Partial<BuildiumUnit>): BuildiumUnit {
  return {
    Id: 10,
    PropertyId: 100,
    UnitNumber: "1",
    UnitSize: null,
    MarketRent: null,
    IsUnitOccupied: true,
    ...overrides,
  };
}

describe("rentLeaseRows", () => {
  it("returns leases sorted by rent descending, excluding leases with no known rent", () => {
    const rows = rentLeaseRows([
      lease({ Id: 1, AccountDetails: { Rent: 1000, SecurityDeposit: 1000 } }),
      lease({ Id: 2, AccountDetails: { Rent: 2000, SecurityDeposit: 2000 } }),
      lease({ Id: 3, AccountDetails: { Rent: null, SecurityDeposit: null } }),
    ]);
    expect(rows.map((r) => r.leaseId)).toEqual(["2", "1"]);
    expect(rows.every((r) => typeof r.rent === "number")).toBe(true);
  });
});

describe("fixedTermLeaseRows / monthToMonthLeaseRows", () => {
  it("classifies Fixed and FixedWithRollover as fixed-term, AtWill as month-to-month", () => {
    const leases = [
      lease({ Id: 1, LeaseType: "Fixed" }),
      lease({ Id: 2, LeaseType: "FixedWithRollover" }),
      lease({ Id: 3, LeaseType: "AtWill" }),
      lease({ Id: 4, LeaseType: "SomethingUnexpected" }),
    ];
    expect(fixedTermLeaseRows(leases).map((r) => r.leaseId)).toEqual(["1", "2"]);
    expect(monthToMonthLeaseRows(leases).map((r) => r.leaseId)).toEqual(["3"]);
  });
});

describe("evictionPendingLeaseRows", () => {
  it("returns only leases with IsEvictionPending true", () => {
    const rows = evictionPendingLeaseRows([
      lease({ Id: 1, IsEvictionPending: true }),
      lease({ Id: 2, IsEvictionPending: false }),
    ]);
    expect(rows.map((r) => r.leaseId)).toEqual(["1"]);
  });
});

describe("tenancyRows", () => {
  it("computes tenancy in months from LeaseFromDate to asOfDate, sorted longest first", () => {
    const asOf = new Date("2026-01-01T00:00:00Z");
    const rows = tenancyRows(
      [
        lease({ Id: 1, LeaseFromDate: "2025-01-01" }), // ~12 months
        lease({ Id: 2, LeaseFromDate: "2025-07-01" }), // ~6 months
        lease({ Id: 3, LeaseFromDate: null }),
      ],
      asOf
    );
    expect(rows.map((r) => r.leaseId)).toEqual(["1", "2"]); // lease 3 excluded (no LeaseFromDate)
    expect(rows[0].tenancyMonths).toBeGreaterThan(rows[1].tenancyMonths);
  });
});

describe("moveInLeaseRows", () => {
  it("returns leases whose LeaseFromDate falls within the given range", () => {
    const rows = moveInLeaseRows(
      [
        lease({ Id: 1, LeaseFromDate: "2026-06-15" }),
        lease({ Id: 2, LeaseFromDate: "2026-05-01" }),
        lease({ Id: 3, LeaseFromDate: null }),
      ],
      "2026-06-01T00:00:00Z",
      "2026-06-30T23:59:59Z"
    );
    expect(rows.map((r) => r.leaseId)).toEqual(["1"]);
  });
});

describe("unitStatusRows / vacantUnitRows", () => {
  it("marks a unit occupied only if it has a currently-Active lease, matching summarizeOccupancy's rule", () => {
    const units = [unit({ Id: 10 }), unit({ Id: 20 })];
    const activeLeases = [lease({ UnitId: 10 })];
    const rows = unitStatusRows(units, activeLeases);
    expect(rows.find((r) => r.unitId === "10")?.occupied).toBe(true);
    expect(rows.find((r) => r.unitId === "20")?.occupied).toBe(false);
    expect(vacantUnitRows(units, activeLeases).map((r) => r.unitId)).toEqual(["20"]);
  });
});

describe("vacantUnitDaysRows / averageDaysVacant", () => {
  it("computes days vacant from the most recent LeaseToDate, excluding units with no lease history", () => {
    const asOf = new Date("2026-07-01T00:00:00Z");
    const units = [unit({ Id: 10 }), unit({ Id: 20 })];
    const activeLeases: BuildiumLease[] = []; // both vacant
    const allLeases = [
      lease({ Id: 1, UnitId: 10, LeaseToDate: "2026-06-01" }), // 30 days vacant
      lease({ Id: 2, UnitId: 10, LeaseToDate: "2026-05-01" }), // older — should NOT be picked (most recent wins)
      // unit 20 has no lease history at all
    ];
    const rows = vacantUnitDaysRows(units, activeLeases, allLeases, asOf);
    const unit10 = rows.find((r) => r.unitId === "10");
    const unit20 = rows.find((r) => r.unitId === "20");
    expect(unit10?.daysVacant).toBe(30);
    expect(unit10?.lastLeaseToDate).toBe("2026-06-01");
    expect(unit20?.daysVacant).toBeNull();

    expect(averageDaysVacant(rows)).toBe(30); // unit 20's null is excluded from the average, not counted as 0
  });

  it("returns null average when no vacant unit has a known days-vacant value", () => {
    expect(averageDaysVacant([{ unitId: "1", propertyId: "1", unitNumber: "1", daysVacant: null, lastLeaseToDate: null }])).toBeNull();
  });
});

// Mirrors summarizeRenewalRate's classification (occupancy.test.ts has the
// full formula rationale) — this just re-shapes the same renewed/moved-out
// leases into a drill-down row list, so the tile and its drill-down can
// never disagree.
describe("renewalRateRows", () => {
  const asOf = new Date("2026-07-05T00:00:00Z");

  it("includes a renewed lease (non-Past, term > 365 days, updated in trailing 12mo)", () => {
    const leases = [
      lease({
        Id: 1,
        LeaseStatus: "Active",
        LeaseFromDate: "2024-01-01",
        LeaseToDate: "2027-01-01",
        LastUpdatedDateTime: "2026-03-01T00:00:00Z",
      }),
    ];
    const rows = renewalRateRows(leases, asOf);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("renewed");
    expect(rows[0].leaseId).toBe("1");
  });

  it("includes a moved-out lease (Past, LeaseToDate in trailing 12mo, full term)", () => {
    const leases = [
      lease({ Id: 2, LeaseStatus: "Past", LeaseFromDate: "2025-01-01", LeaseToDate: "2026-01-01" }),
    ];
    const rows = renewalRateRows(leases, asOf);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("moved_out");
  });

  it("excludes a lease that doesn't meet either classification", () => {
    const leases = [
      lease({ Id: 3, LeaseStatus: "Active", LeaseFromDate: "2026-01-01", LeaseToDate: "2026-12-31", LastUpdatedDateTime: "2026-06-01T00:00:00Z" }), // plain 1yr, not renewed
    ];
    expect(renewalRateRows(leases, asOf)).toEqual([]);
  });

  it("sorts rows by leaseToDate, most recent first", () => {
    const leases = [
      lease({ Id: 1, LeaseStatus: "Past", LeaseFromDate: "2025-01-01", LeaseToDate: "2026-01-01" }),
      lease({ Id: 2, LeaseStatus: "Past", LeaseFromDate: "2025-03-01", LeaseToDate: "2026-03-01" }),
    ];
    const rows = renewalRateRows(leases, asOf);
    expect(rows.map((r) => r.leaseId)).toEqual(["2", "1"]);
  });
});
