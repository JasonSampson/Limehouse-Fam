import { describe, it, expect } from "vitest";
import { summarizeDelinquency, delinquentLeaseRows } from "../../src/buildium/delinquency.js";
import type { LeaseBalance } from "../../src/buildium/client.js";

// Regression coverage matching the rigor of late-rent-notices'
// noticeLineItems.test.ts: this locks in that delinquency is always
// computed from Buildium's own netted outstandingbalances TotalBalance
// (never from summing charge history, which produced a 35x-inflated real
// number on a real lease in the sibling project). Also locks in the
// negative-balance-is-a-credit-not-debt rule, which is easy to get wrong
// (naive `balance !== 0` filtering would wrongly count tenant credits as
// delinquency and inflate totalOutstandingBalance).
function balance(overrides: Partial<LeaseBalance>): LeaseBalance {
  return {
    leaseId: "1",
    propertyId: "1",
    balance: 0,
    evictionPendingDate: null,
    balancesByGl: [],
    ...overrides,
  };
}

describe("summarizeDelinquency", () => {
  it("sums only positive balances, excluding credits", () => {
    const balances: LeaseBalance[] = [
      balance({ leaseId: "1", balance: 500 }),
      balance({ leaseId: "2", balance: 1200.5 }),
      balance({ leaseId: "3", balance: -300 }), // tenant credit, not debt
    ];
    const summary = summarizeDelinquency(balances);
    expect(summary.totalOutstandingBalance).toBe(1700.5);
    expect(summary.delinquentLeaseCount).toBe(2);
  });

  it("counts eviction-pending leases and their balance separately", () => {
    const balances: LeaseBalance[] = [
      balance({ leaseId: "1", balance: 3115.95, evictionPendingDate: "2026-06-01" }),
      balance({ leaseId: "2", balance: 800, evictionPendingDate: null }),
    ];
    const summary = summarizeDelinquency(balances);
    expect(summary.evictionPendingCount).toBe(1);
    expect(summary.evictionPendingBalance).toBe(3115.95);
    expect(summary.totalOutstandingBalance).toBe(3915.95);
  });

  it("returns zeroed summary for an empty portfolio (no leases owe anything)", () => {
    const summary = summarizeDelinquency([]);
    expect(summary.totalOutstandingBalance).toBe(0);
    expect(summary.delinquentLeaseCount).toBe(0);
    expect(summary.evictionPendingCount).toBe(0);
    expect(summary.evictionPendingBalance).toBe(0);
  });

  it("reproduces the real lease 2317038 balance exactly (regression anchor from late-rent-notices)", () => {
    // Same real-world number that exposed the charge-history-sum bug in the
    // sibling project: the TRUE balance is $3,115.95, not the $110,044.67
    // you'd get from summing lifetime charges. This dashboard must only
    // ever ingest the already-correct outstandingbalances TotalBalance.
    const balances: LeaseBalance[] = [balance({ leaseId: "2317038", balance: 3115.95 })];
    const summary = summarizeDelinquency(balances);
    expect(summary.totalOutstandingBalance).toBe(3115.95);
  });
});

describe("delinquentLeaseRows", () => {
  it("excludes credits and sorts by balance descending", () => {
    const balances: LeaseBalance[] = [
      balance({ leaseId: "1", propertyId: "p1", balance: 500 }),
      balance({ leaseId: "2", propertyId: "p2", balance: 1200.5 }),
      balance({ leaseId: "3", propertyId: "p3", balance: -50 }),
    ];
    const rows = delinquentLeaseRows(balances);
    expect(rows).toHaveLength(2);
    expect(rows[0].leaseId).toBe("2");
    expect(rows[1].leaseId).toBe("1");
  });

  it("returns the property/unit/balance shape needed by the drill-down view", () => {
    const balances: LeaseBalance[] = [
      balance({ leaseId: "10", propertyId: "p10", balance: 250, evictionPendingDate: "2026-05-15" }),
    ];
    const rows = delinquentLeaseRows(balances);
    expect(rows[0]).toEqual({
      leaseId: "10",
      propertyId: "p10",
      balance: 250,
      evictionPendingDate: "2026-05-15",
    });
  });
});
