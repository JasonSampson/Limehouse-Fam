import { describe, it, expect } from "vitest";
import { bucketDelinquencyByAge, daysLateAsOf, type AgingInput } from "../../src/buildium/delinquency.js";

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
