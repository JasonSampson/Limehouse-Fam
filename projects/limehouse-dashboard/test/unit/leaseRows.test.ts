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
  securityDepositWithheldRows,
} from "../../src/kpi/leaseRows.js";
import type { BuildiumLease, BuildiumUnit } from "../../src/buildium/client.js";
import type { LeaseDepositWithheld, MoveOutWindow } from "../../src/kpi/rentCollection.js";

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
  // CONFIRMED LIVE 2026-07-06: matches the vendor's real "Vacant — Not
  // Rented" tile (22), which uses Buildium's own IsUnitOccupied flag
  // directly — NOT the lease-based rule summarizeOccupancy uses for the
  // Occupancy percentage (a real, confirmed inconsistency on the vendor's
  // own site between these two tiles).
  it("marks a unit occupied/vacant directly from IsUnitOccupied, not lease presence", () => {
    const units = [unit({ Id: 10, IsUnitOccupied: true }), unit({ Id: 20, IsUnitOccupied: false })];
    const rows = unitStatusRows(units);
    expect(rows.find((r) => r.unitId === "10")?.occupied).toBe(true);
    expect(rows.find((r) => r.unitId === "20")?.occupied).toBe(false);
    expect(vacantUnitRows(units).map((r) => r.unitId)).toEqual(["20"]);
  });
});

describe("vacantUnitDaysRows / averageDaysVacant", () => {
  it("computes days vacant from the most recent LeaseToDate, excluding units with no lease history", () => {
    const asOf = new Date("2026-07-01T00:00:00Z");
    const units = [unit({ Id: 10, IsUnitOccupied: false }), unit({ Id: 20, IsUnitOccupied: false })];
    const allLeases = [
      lease({ Id: 1, UnitId: 10, LeaseToDate: "2026-06-01" }), // 30 days vacant
      lease({ Id: 2, UnitId: 10, LeaseToDate: "2026-05-01" }), // older — should NOT be picked (most recent wins)
      // unit 20 has no lease history at all
    ];
    const rows = vacantUnitDaysRows(units, allLeases, asOf);
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

  it("includes a renewed lease (non-Past, Rent effective date within trailing 12mo), with fromDate set to that Rent date", () => {
    const leases = [lease({ Id: 1, LeaseStatus: "Active", LeaseToDate: "2027-01-01" })];
    const rentDates = new Map([["1", "2026-03-01"]]);
    const rows = renewalRateRows(leases, rentDates, asOf);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("renewed");
    expect(rows[0].leaseId).toBe("1");
    expect(rows[0].fromDate).toBe("2026-03-01");
    expect(rows[0].toDate).toBe("2027-01-01");
  });

  it("includes a moved-out lease (Past, LeaseToDate in trailing 12mo, full term), with fromDate set to the lease's real LeaseFromDate", () => {
    const leases = [
      lease({ Id: 2, LeaseStatus: "Past", LeaseFromDate: "2025-01-01", LeaseToDate: "2026-01-01" }),
    ];
    const rows = renewalRateRows(leases, new Map(), asOf);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("moved_out");
    expect(rows[0].fromDate).toBe("2025-01-01");
  });


  it("excludes a non-Past lease with no Rent effective date on file", () => {
    const leases = [lease({ Id: 3, LeaseStatus: "Active" })];
    expect(renewalRateRows(leases, new Map(), asOf)).toEqual([]);
  });

  it("excludes a lease whose Rent effective date is just the original move-in charge, not a later renewal", () => {
    const leases = [lease({ Id: 4, LeaseStatus: "Active", LeaseFromDate: "2026-03-01" })];
    const rentDates = new Map([["4", "2026-03-01"]]); // same date as LeaseFromDate — day one, not a renewal
    expect(renewalRateRows(leases, rentDates, asOf)).toEqual([]);
  });

  it("excludes a lease whose Rent effective date is only a couple weeks after move-in (proration, not a renewal)", () => {
    const leases = [lease({ Id: 6, LeaseStatus: "Active", LeaseFromDate: "2026-08-17" })];
    const rentDates = new Map([["6", "2026-09-01"]]); // 15 days later — first full month, not a renewal
    expect(renewalRateRows(leases, rentDates, asOf)).toEqual([]);
  });

  it("includes a renewed lease even when its Rent effective date is in the future (already scheduled ahead of time)", () => {
    const leases = [lease({ Id: 5, LeaseStatus: "Active", LeaseToDate: "2027-08-31" })];
    const rentDates = new Map([["5", "2026-09-01"]]); // after asOf (2026-07-05) — scheduled ahead
    const rows = renewalRateRows(leases, rentDates, asOf);
    expect(rows).toHaveLength(1);
    expect(rows[0].fromDate).toBe("2026-09-01");
  });

  it("sorts rows by toDate, most recent first", () => {
    const leases = [
      lease({ Id: 1, LeaseStatus: "Past", LeaseFromDate: "2025-01-01", LeaseToDate: "2026-01-01" }),
      lease({ Id: 2, LeaseStatus: "Past", LeaseFromDate: "2025-03-01", LeaseToDate: "2026-03-01" }),
    ];
    const rows = renewalRateRows(leases, new Map(), asOf);
    expect(rows.map((r) => r.leaseId)).toEqual(["2", "1"]);
  });
});

describe("securityDepositWithheldRows", () => {
  const window: MoveOutWindow = { start: "2025-06-09", end: "2026-06-09" };

  function withheld(leaseId: string, amount: number, hasQualifyingEntry = true): [string, LeaseDepositWithheld] {
    return [leaseId, { leaseId, withheld: amount, hasQualifyingEntry }];
  }

  it("includes a Past lease that moved out within the window, has a known deposit, and has a qualifying entry", () => {
    const leases = [lease({ Id: 1, LeaseStatus: "Past", LeaseToDate: "2026-03-11", AccountDetails: { Rent: 1500, SecurityDeposit: 2450 } })];
    const rows = securityDepositWithheldRows(leases, new Map([withheld("1", 2450)]), window);
    expect(rows).toEqual([
      { leaseId: "1", propertyId: "100", unitNumber: "1", tenantName: "Jane Doe", moveOutDate: "2026-03-11", securityDeposit: 2450, withheld: 2450, percent: 100 },
    ]);
  });

  it("excludes a lease whose move-out date falls outside the window (too recent or too old)", () => {
    const leases = [
      lease({ Id: 1, LeaseStatus: "Past", LeaseToDate: "2026-06-20" }), // after window.end — too recent, not reconciled yet
      lease({ Id: 2, LeaseStatus: "Past", LeaseToDate: "2025-01-01" }), // before window.start — too old
    ];
    const withheldByLeaseId = new Map([withheld("1", 500), withheld("2", 500)]);
    expect(securityDepositWithheldRows(leases, withheldByLeaseId, window)).toEqual([]);
  });

  it("excludes a lease with no known deposit amount (null or zero)", () => {
    const leases = [
      lease({ Id: 1, LeaseStatus: "Past", LeaseToDate: "2026-01-01", AccountDetails: { Rent: 1500, SecurityDeposit: null } }),
      lease({ Id: 2, LeaseStatus: "Past", LeaseToDate: "2026-01-01", AccountDetails: { Rent: 1500, SecurityDeposit: 0 } }),
    ];
    const withheldByLeaseId = new Map([withheld("1", 500), withheld("2", 500)]);
    expect(securityDepositWithheldRows(leases, withheldByLeaseId, window)).toEqual([]);
  });

  it("excludes a lease with no qualifying reconciliation entry yet, rather than showing it as $0/0%", () => {
    const leases = [lease({ Id: 1, LeaseStatus: "Past", LeaseToDate: "2026-01-01", AccountDetails: { Rent: 1500, SecurityDeposit: 2000 } })];
    const withheldByLeaseId = new Map([withheld("1", 0, false)]);
    expect(securityDepositWithheldRows(leases, withheldByLeaseId, window)).toEqual([]);
  });

  it("excludes a lease absent from the withheld map entirely", () => {
    const leases = [lease({ Id: 1, LeaseStatus: "Past", LeaseToDate: "2026-01-01", AccountDetails: { Rent: 1500, SecurityDeposit: 2000 } })];
    expect(securityDepositWithheldRows(leases, new Map(), window)).toEqual([]);
  });

  it("caps withheld at the lease's own deposit amount", () => {
    // Real vendor rule: withheld can never exceed what was actually
    // collected — a data-entry overshoot on the Buildium side shouldn't
    // produce a >100% row.
    const leases = [lease({ Id: 1, LeaseStatus: "Past", LeaseToDate: "2026-01-01", AccountDetails: { Rent: 1500, SecurityDeposit: 1000 } })];
    const rows = securityDepositWithheldRows(leases, new Map([withheld("1", 1450)]), window);
    expect(rows[0].withheld).toBe(1000);
    expect(rows[0].percent).toBe(100);
  });

  it("sorts rows by percent withheld, descending", () => {
    const leases = [
      lease({ Id: 1, LeaseStatus: "Past", LeaseToDate: "2026-01-01", AccountDetails: { Rent: 1500, SecurityDeposit: 2860 } }),
      lease({ Id: 2, LeaseStatus: "Past", LeaseToDate: "2026-02-01", AccountDetails: { Rent: 1500, SecurityDeposit: 2450 } }),
    ];
    const withheldByLeaseId = new Map([withheld("1", 35), withheld("2", 2450)]); // 1.2% vs 100%
    const rows = securityDepositWithheldRows(leases, withheldByLeaseId, window);
    expect(rows.map((r) => r.leaseId)).toEqual(["2", "1"]);
  });
});
