import { describe, it, expect } from "vitest";
import { isNotGhostLease } from "../../src/buildium/client.js";
import type { BuildiumLease } from "../../src/buildium/client.js";

function lease(overrides: Partial<BuildiumLease>): BuildiumLease {
  return {
    Id: 1,
    PropertyId: 1,
    UnitId: 1,
    UnitNumber: "1",
    LeaseStatus: "Active",
    LeaseType: "Fixed",
    LeaseFromDate: "2025-01-01",
    LeaseToDate: "2025-12-31",
    IsEvictionPending: false,
    PaymentDueDay: 1,
    CurrentTenants: [{ Id: 1, FirstName: "Jane", LastName: "Doe", Email: null }],
    MoveOutData: [],
    Tenants: [],
    ...overrides,
  };
}

describe("isNotGhostLease", () => {
  it("keeps a Past lease regardless of CurrentTenants", () => {
    expect(isNotGhostLease(lease({ LeaseStatus: "Past", CurrentTenants: null }))).toBe(true);
  });

  it("keeps a Future lease regardless of CurrentTenants (Buildium never populates it for real Future leases)", () => {
    expect(isNotGhostLease(lease({ LeaseStatus: "Future", CurrentTenants: null }))).toBe(true);
  });

  it("keeps an Active lease with a populated CurrentTenants", () => {
    expect(isNotGhostLease(lease({ LeaseStatus: "Active", CurrentTenants: [{ Id: 1, FirstName: "Jane", LastName: "Doe", Email: null }] }))).toBe(
      true
    );
  });

  it("drops an Active lease with empty CurrentTenants (the ghost case)", () => {
    expect(isNotGhostLease(lease({ LeaseStatus: "Active", CurrentTenants: [] }))).toBe(false);
  });

  it("drops an Active lease with null CurrentTenants", () => {
    expect(isNotGhostLease(lease({ LeaseStatus: "Active", CurrentTenants: null }))).toBe(false);
  });

  // Real example, per Jason directly: 1004 Port Side Way — a completed,
  // real lease (tenant moved in 5/1/2025, bought the house at lease end
  // 5/14/2026) that Buildium still labels LeaseStatus="Active" with an
  // empty CurrentTenants (the tenant is gone). isNotGhostLease correctly
  // treats this as a ghost for OCCUPANCY purposes — but
  // estimatePropertyLossDates (churn.ts) must be given leases from BEFORE
  // this filter runs, or exactly this kind of real, completed lease
  // silently vanishes from the Doors Lost estimate (confirmed live: this
  // was the actual cause of 1004 Port Side Way missing from Doors Lost).
  it("drops the real 1004 Port Side Way lease shape — Active status, real dates, tenant already moved out", () => {
    const portSideWay = lease({
      LeaseStatus: "Active",
      LeaseFromDate: "2025-05-01",
      LeaseToDate: "2026-05-14",
      CurrentTenants: [],
    });
    expect(isNotGhostLease(portSideWay)).toBe(false);
  });
});
