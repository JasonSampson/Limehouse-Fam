import { describe, it, expect } from "vitest";
import {
  bucketDelinquencyByAge,
  daysLateAsOf,
  leaseAgingInputsFromTransactions,
  type AgingInput,
  type TransactionForAging,
} from "../../src/buildium/delinquency.js";

describe("bucketDelinquencyByAge", () => {
  it("sorts balances into the correct bucket by days late", () => {
    const inputs: AgingInput[] = [
      { leaseId: "1", balance: 500, daysLate: 15 }, // 0-30
      { leaseId: "2", balance: 800, daysLate: 45 }, // 31-60
      { leaseId: "3", balance: 1200, daysLate: 75 }, // 61-90
      { leaseId: "4", balance: 3000, daysLate: 120 }, // 90+
    ];
    const buckets = bucketDelinquencyByAge(inputs);
    expect(buckets).toEqual([
      { label: "0-30", totalBalance: 500, leaseCount: 1 },
      { label: "31-60", totalBalance: 800, leaseCount: 1 },
      { label: "61-90", totalBalance: 1200, leaseCount: 1 },
      { label: "90+", totalBalance: 3000, leaseCount: 1 },
    ]);
  });

  it("sums multiple leases into the same bucket", () => {
    const inputs: AgingInput[] = [
      { leaseId: "1", balance: 500, daysLate: 5 },
      { leaseId: "2", balance: 250.5, daysLate: 10 },
    ];
    const buckets = bucketDelinquencyByAge(inputs);
    const zeroToThirty = buckets.find((b) => b.label === "0-30")!;
    expect(zeroToThirty.totalBalance).toBe(750.5);
    expect(zeroToThirty.leaseCount).toBe(2);
  });

  // CONFIRMED LIVE 2026-07-06: leaseAgingInputsFromTransactions can emit
  // several AgingInput rows for one lease (one per still-open charge) once
  // its FIFO total reconciles — leaseCount must count distinct leases, not
  // input rows, or a lease with several open charges gets counted multiple
  // times in the same bucket, or once per bucket its charges fall into.
  it("counts a lease with multiple open charges once per bucket, not once per charge", () => {
    const inputs: AgingInput[] = [
      { leaseId: "1", balance: 100, daysLate: 10 }, // 0-30
      { leaseId: "1", balance: 200, daysLate: 15 }, // 0-30, same lease as above
      { leaseId: "1", balance: 300, daysLate: 45 }, // 31-60, same lease again
      { leaseId: "2", balance: 400, daysLate: 20 }, // 0-30, different lease
    ];
    const buckets = bucketDelinquencyByAge(inputs);
    const zeroToThirty = buckets.find((b) => b.label === "0-30")!;
    const thirtyToSixty = buckets.find((b) => b.label === "31-60")!;
    expect(zeroToThirty.totalBalance).toBe(700); // 100 + 200 + 400
    expect(zeroToThirty.leaseCount).toBe(2); // leases 1 and 2, not 3 rows
    expect(thirtyToSixty.totalBalance).toBe(300);
    expect(thirtyToSixty.leaseCount).toBe(1); // lease 1 also appears here
  });

  it("respects exact boundary values (30, 60, 90 land in the lower bucket)", () => {
    const inputs: AgingInput[] = [
      { leaseId: "1", balance: 100, daysLate: 30 },
      { leaseId: "2", balance: 100, daysLate: 31 },
      { leaseId: "3", balance: 100, daysLate: 60 },
      { leaseId: "4", balance: 100, daysLate: 61 },
      { leaseId: "5", balance: 100, daysLate: 90 },
      { leaseId: "6", balance: 100, daysLate: 91 },
    ];
    const buckets = bucketDelinquencyByAge(inputs);
    const byLabel = Object.fromEntries(buckets.map((b) => [b.label, b.leaseCount]));
    expect(byLabel["0-30"]).toBe(1); // day 30
    expect(byLabel["31-60"]).toBe(2); // days 31, 60
    expect(byLabel["61-90"]).toBe(2); // days 61, 90
    expect(byLabel["90+"]).toBe(1); // day 91
  });

  it("excludes credits (negative/zero balances), same rule as summarizeDelinquency", () => {
    const inputs: AgingInput[] = [
      { leaseId: "1", balance: -50, daysLate: 45 },
      { leaseId: "2", balance: 0, daysLate: 45 },
      { leaseId: "3", balance: 200, daysLate: 45 },
    ];
    const buckets = bucketDelinquencyByAge(inputs);
    const thirtyToSixty = buckets.find((b) => b.label === "31-60")!;
    expect(thirtyToSixty.leaseCount).toBe(1);
    expect(thirtyToSixty.totalBalance).toBe(200);
  });

  it("returns all 4 buckets even when there is nothing delinquent (empty state, not missing keys)", () => {
    const buckets = bucketDelinquencyByAge([]);
    expect(buckets.map((b) => b.label)).toEqual(["0-30", "31-60", "61-90", "90+"]);
    expect(buckets.every((b) => b.totalBalance === 0 && b.leaseCount === 0)).toBe(true);
  });
});

describe("daysLateAsOf", () => {
  it("computes days late from this month's due date when it has already passed", () => {
    const asOf = new Date("2026-07-20T00:00:00Z");
    expect(daysLateAsOf(5, asOf)).toBe(15); // due July 5, today July 20 -> 15 days late
  });

  it("uses LAST month's due date when this month's due date has not happened yet", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    // Due day is the 20th — July 20 hasn't happened, so the relevant due
    // date is June 20 (17 days before July 3, since June has 30 days).
    expect(daysLateAsOf(20, asOf)).toBe(13);
  });

  it("returns 0 on the due date itself (not late yet)", () => {
    const asOf = new Date("2026-07-05T00:00:00Z");
    expect(daysLateAsOf(5, asOf)).toBe(0);
  });

  it("returns 0 (not throw) when PaymentDueDay is null", () => {
    const asOf = new Date("2026-07-05T00:00:00Z");
    expect(daysLateAsOf(null, asOf)).toBe(0);
  });

  it("rolls back across a year boundary correctly", () => {
    const asOf = new Date("2026-01-05T00:00:00Z");
    // Due day 20th, hasn't happened this January yet -> use Dec 20, 2025.
    // Dec 20 -> Jan 5 is 16 days.
    expect(daysLateAsOf(20, asOf)).toBe(16);
  });
});

// CONFIRMED LIVE 2026-07-06: replaces daysLateAsOf for the real Delinquency
// Aging tile — daysLateAsOf only ever looks at the most recent month's due
// date, so a balance unpaid for 2+ months always computed as <=30 days
// late. This walks real transaction history FIFO instead.
describe("leaseAgingInputsFromTransactions", () => {
  function txn(date: string, totalAmount: number): TransactionForAging {
    return { date, totalAmount };
  }

  it("splits a balance across multiple charge dates when only the oldest charge was paid", () => {
    const asOf = new Date("2026-07-06T00:00:00Z");
    const transactions = [
      txn("2026-05-01", 1000), // May charge
      txn("2026-05-05", -1000), // May charge fully paid
      txn("2026-06-01", 1000), // June charge -- unpaid
      txn("2026-07-01", 1000), // July charge -- unpaid
    ];
    // Real Buildium balance for this lease: 2000 (June + July charges).
    const result = leaseAgingInputsFromTransactions("L1", 2000, transactions, asOf);
    expect(result).toEqual([
      { leaseId: "L1", balance: 1000, daysLate: 35 }, // June 1 -> July 6
      { leaseId: "L1", balance: 1000, daysLate: 5 }, // July 1 -> July 6
    ]);
  });

  it("applies a payment FIFO against the oldest open charge first", () => {
    const asOf = new Date("2026-07-06T00:00:00Z");
    const transactions = [
      txn("2026-05-01", 1000), // old charge
      txn("2026-06-01", 1000), // newer charge
      txn("2026-06-15", -600), // partial payment -- eats into the OLDER charge first
    ];
    // Real balance: 1000 (May, partially paid down to 400) + 1000 (June) = 1400.
    const result = leaseAgingInputsFromTransactions("L1", 1400, transactions, asOf);
    expect(result).toEqual([
      { leaseId: "L1", balance: 400, daysLate: 66 }, // May 1 -> July 6, partially paid
      { leaseId: "L1", balance: 1000, daysLate: 35 }, // June 1 -> July 6
    ]);
  });

  it("falls back to a single bucket (whole balance, oldest charge date) when FIFO total doesn't reconcile with the real balance", () => {
    const asOf = new Date("2026-07-06T00:00:00Z");
    // Only the last 2 months of history are available -- doesn't cover the
    // real balance, which is bigger than what these transactions add up to.
    const transactions = [txn("2026-06-01", 500)];
    const result = leaseAgingInputsFromTransactions("L1", 5000, transactions, asOf);
    expect(result).toEqual([{ leaseId: "L1", balance: 5000, daysLate: 35 }]);
  });

  it("falls back to 'not late' (0 days) when there's no transaction history at all", () => {
    const asOf = new Date("2026-07-06T00:00:00Z");
    const result = leaseAgingInputsFromTransactions("L1", 500, [], asOf);
    expect(result).toEqual([{ leaseId: "L1", balance: 500, daysLate: 0 }]);
  });

  it("fully nets out a lease with no remaining open charges to an empty result", () => {
    const asOf = new Date("2026-07-06T00:00:00Z");
    const transactions = [txn("2026-06-01", 1000), txn("2026-06-05", -1000)];
    const result = leaseAgingInputsFromTransactions("L1", 0, transactions, asOf);
    expect(result).toEqual([]);
  });

  // CONFIRMED LIVE 2026-07-06: a payment bigger than every open charge at
  // that moment used to just vanish once the queue emptied, instead of
  // being credited toward the NEXT charge — that made 3 real leases look
  // far more overdue than they actually were (their FIFO total never
  // reconciled with Buildium's real balance, so they always fell back to
  // the single-bucket/oldest-charge-date path with a wrong, too-old date).
  it("carries an overpayment forward as a credit against the next charge, instead of discarding it", () => {
    const asOf = new Date("2026-07-06T00:00:00Z");
    const transactions = [
      txn("2026-05-01", 1000), // May charge
      txn("2026-05-10", -1500), // overpays May by 500 -- the extra 500 should credit June
      txn("2026-06-01", 1000), // June charge -- only 500 of it should still be open
    ];
    // Real balance: June charge (1000) minus the 500 credit carried forward = 500.
    const result = leaseAgingInputsFromTransactions("L1", 500, transactions, asOf);
    expect(result).toEqual([{ leaseId: "L1", balance: 500, daysLate: 35 }]); // June 1 -> July 6
  });
});
