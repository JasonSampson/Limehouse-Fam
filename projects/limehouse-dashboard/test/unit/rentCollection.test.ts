import { describe, it, expect } from "vitest";
import {
  summarizeRentAndDeposit,
  summarizeMonthlyCollectionRates,
  earliestPaymentPerMonth,
  type LeasePaymentForMonth,
} from "../../src/kpi/rentCollection.js";
import type { BuildiumLease, BuildiumLeaseTransaction } from "../../src/buildium/client.js";

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

describe("summarizeRentAndDeposit", () => {
  it("averages rent and security deposit across leases with known amounts", () => {
    const leases = [
      lease({ CurrentRent: { Amount: 1000 }, SecurityDeposit: { Amount: 1000 } }),
      lease({ CurrentRent: { Amount: 1500 }, SecurityDeposit: { Amount: 750 } }),
    ];
    const result = summarizeRentAndDeposit(leases);
    expect(result.avgRentPerLease).toBe(1250);
    expect(result.avgSecurityDepositWithheld).toBe(875);
    expect(result.avgSecurityDepositWithheldPercent).toBe(70); // 875/1250
  });

  it("skips leases with a missing rent or deposit amount rather than treating them as 0", () => {
    const leases = [
      lease({ CurrentRent: { Amount: 1000 }, SecurityDeposit: { Amount: 1000 } }),
      lease({ CurrentRent: null, SecurityDeposit: null }),
    ];
    const result = summarizeRentAndDeposit(leases);
    expect(result.avgRentPerLease).toBe(1000); // not dragged down to 500 by the null
    expect(result.avgSecurityDepositWithheld).toBe(1000);
  });

  it("returns nulls (not NaN/0) when no leases have rent data at all", () => {
    const leases = [lease({ CurrentRent: null, SecurityDeposit: null })];
    const result = summarizeRentAndDeposit(leases);
    expect(result.avgRentPerLease).toBeNull();
    expect(result.avgSecurityDepositWithheld).toBeNull();
    expect(result.avgSecurityDepositWithheldPercent).toBeNull();
  });

  it("handles CurrentRent/SecurityDeposit being entirely absent (optional fields)", () => {
    const leases = [lease({})];
    const result = summarizeRentAndDeposit(leases);
    expect(result.avgRentPerLease).toBeNull();
  });
});

describe("summarizeMonthlyCollectionRates", () => {
  it("computes paid-by-3rd and paid-by-10th percentages per month", () => {
    const duePerMonth = [
      { leaseId: "1", month: "2026-06" },
      { leaseId: "2", month: "2026-06" },
      { leaseId: "3", month: "2026-06" },
      { leaseId: "4", month: "2026-06" },
    ];
    const payments: LeasePaymentForMonth[] = [
      { leaseId: "1", month: "2026-06", paymentDate: "2026-06-02" }, // by 3rd and by 10th
      { leaseId: "2", month: "2026-06", paymentDate: "2026-06-07" }, // by 10th only
      { leaseId: "3", month: "2026-06", paymentDate: "2026-06-15" }, // neither
      { leaseId: "4", month: "2026-06", paymentDate: null }, // unpaid
    ];
    const result = summarizeMonthlyCollectionRates(duePerMonth, payments);
    expect(result).toEqual([
      {
        month: "2026-06",
        totalLeasesDue: 4,
        paidByThirdCount: 1,
        paidByThirdPercent: 25,
        paidByTenthCount: 2,
        paidByTenthPercent: 50,
      },
    ]);
  });

  it("treats a lease with no matching payment record as unpaid, not a crash", () => {
    const duePerMonth = [{ leaseId: "1", month: "2026-06" }];
    const result = summarizeMonthlyCollectionRates(duePerMonth, []);
    expect(result[0].paidByThirdCount).toBe(0);
    expect(result[0].paidByTenthCount).toBe(0);
  });

  it("sorts multiple months chronologically", () => {
    const duePerMonth = [
      { leaseId: "1", month: "2026-07" },
      { leaseId: "1", month: "2026-05" },
      { leaseId: "1", month: "2026-06" },
    ];
    const result = summarizeMonthlyCollectionRates(duePerMonth, []);
    expect(result.map((r) => r.month)).toEqual(["2026-05", "2026-06", "2026-07"]);
  });

  it("boundary: day 3 counts as paid-by-3rd, day 10 counts as paid-by-10th", () => {
    const duePerMonth = [
      { leaseId: "1", month: "2026-06" },
      { leaseId: "2", month: "2026-06" },
    ];
    const payments: LeasePaymentForMonth[] = [
      { leaseId: "1", month: "2026-06", paymentDate: "2026-06-03" },
      { leaseId: "2", month: "2026-06", paymentDate: "2026-06-10" },
    ];
    const result = summarizeMonthlyCollectionRates(duePerMonth, payments);
    expect(result[0].paidByThirdCount).toBe(1); // only the day-3 payment
    expect(result[0].paidByTenthCount).toBe(2); // both day-3 and day-10 are <=10
  });
});

describe("earliestPaymentPerMonth", () => {
  it("picks the earliest Payment transaction per month, ignoring non-Payment types", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      { Id: 1, LeaseId: 10, Date: "2026-06-15", TransactionType: "Charge", TotalAmount: 1000 },
      { Id: 2, LeaseId: 10, Date: "2026-06-08", TransactionType: "Payment", TotalAmount: 1000 },
      { Id: 3, LeaseId: 10, Date: "2026-06-02", TransactionType: "Payment", TotalAmount: 1000 },
    ];
    const result = earliestPaymentPerMonth("10", transactions);
    expect(result).toEqual([{ leaseId: "10", month: "2026-06", paymentDate: "2026-06-02" }]);
  });

  it("returns separate entries for separate months", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      { Id: 1, LeaseId: 10, Date: "2026-05-05", TransactionType: "Payment", TotalAmount: 1000 },
      { Id: 2, LeaseId: 10, Date: "2026-06-05", TransactionType: "Payment", TotalAmount: 1000 },
    ];
    const result = earliestPaymentPerMonth("10", transactions);
    expect(result).toHaveLength(2);
  });

  it("returns an empty array when there are no Payment transactions", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      { Id: 1, LeaseId: 10, Date: "2026-06-15", TransactionType: "Charge", TotalAmount: 1000 },
    ];
    expect(earliestPaymentPerMonth("10", transactions)).toEqual([]);
  });
});
