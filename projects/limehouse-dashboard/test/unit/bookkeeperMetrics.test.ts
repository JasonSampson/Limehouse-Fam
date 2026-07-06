import { describe, it, expect } from "vitest";
import {
  summarizeReconciliationAccuracy,
  summarizeRentProcessingAccuracy,
  scopeMaintenanceVendors,
  summarizeVendorCompliance,
  summarize1099Compliance,
  type ReconciliationAccuracyInput,
} from "../../src/kpi/bookkeeperMetrics.js";
import type { BuildiumBankAccount, BuildiumVendor, BuildiumLeaseTransaction } from "../../src/buildium/client.js";

function bankAccount(overrides: Partial<BuildiumBankAccount>): BuildiumBankAccount {
  return { Id: 1, Name: "Test Account", IsActive: true, Balance: 0, ...overrides };
}

function vendor(overrides: Partial<BuildiumVendor>): BuildiumVendor {
  return {
    Id: 1,
    IsActive: true,
    CompanyName: "Test Vendor",
    Category: { Id: 1, Name: "Contractors - Plumbing" },
    VendorInsurance: { Provider: null, PolicyNumber: null, ExpirationDate: null },
    TaxInformation: { TaxPayerIdType: null, TaxPayerId: null, IncludeIn1099: false },
    ...overrides,
  };
}

function txn(overrides: Partial<BuildiumLeaseTransaction> & { memo?: string }): BuildiumLeaseTransaction {
  const { memo, ...rest } = overrides;
  return {
    Id: 1,
    LeaseId: 1,
    Date: "2026-06-15",
    TransactionType: "Payment",
    TotalAmount: 0,
    Journal: memo !== undefined ? { Memo: memo, Lines: [] } : undefined,
    ...rest,
  };
}

describe("summarizeReconciliationAccuracy", () => {
  it("counts a finished reconciliation matching a completed month as done", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Balance: 1000 }),
      reconcilable: true,
      reconciliations: [{ Id: 1, StatementEndingDate: "2026-06-30", IsFinished: true }],
    };
    const result = summarizeReconciliationAccuracy([input], "2026-06-01", "2026-06-30");
    expect(result).toEqual({ accuracyPercent: 100, done: 1, expected: 1, excludedAccountCount: 0, scoredAccountCount: 1 });
  });

  it("counts a missing reconciliation for a nonzero-balance account as a miss", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Balance: 500 }),
      reconcilable: true,
      reconciliations: [],
    };
    const result = summarizeReconciliationAccuracy([input], "2026-06-01", "2026-06-30");
    expect(result.done).toBe(0);
    expect(result.expected).toBe(1);
    expect(result.accuracyPercent).toBe(0);
  });

  it("excludes an account with zero finished reconciliations AND a $0 balance", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Balance: 0 }),
      reconcilable: true,
      reconciliations: [],
    };
    const result = summarizeReconciliationAccuracy([input], "2026-06-01", "2026-06-30");
    expect(result.excludedAccountCount).toBe(1);
    expect(result.scoredAccountCount).toBe(0);
    expect(result.accuracyPercent).toBeNull();
  });

  it("does not count a partial current month as expected", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Balance: 1000 }),
      reconcilable: true,
      reconciliations: [],
    };
    // July 1-5 has no fully-completed month inside it
    const result = summarizeReconciliationAccuracy([input], "2026-07-01", "2026-07-05");
    expect(result.expected).toBe(0);
    expect(result.accuracyPercent).toBeNull();
  });

  it("treats a not-reconcilable (externally-linked) account with a nonzero balance as a miss, not excluded", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Balance: 200 }),
      reconcilable: false,
      reconciliations: [],
    };
    const result = summarizeReconciliationAccuracy([input], "2026-06-01", "2026-06-30");
    expect(result.excludedAccountCount).toBe(0);
    expect(result.done).toBe(0);
    expect(result.expected).toBe(1);
  });

  it("ignores inactive accounts entirely", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Balance: 1000, IsActive: false }),
      reconcilable: true,
      reconciliations: [],
    };
    const result = summarizeReconciliationAccuracy([input], "2026-06-01", "2026-06-30");
    expect(result.expected).toBe(0);
    expect(result.excludedAccountCount).toBe(0);
  });
});

describe("summarizeRentProcessingAccuracy", () => {
  it("computes 1 - (operational reversals / payments)", () => {
    const leaseTransactions = [
      [
        txn({ TransactionType: "Payment", Date: "2026-06-05" }),
        txn({ TransactionType: "Payment", Date: "2026-06-10" }),
        txn({ TransactionType: "Reversed Payment", Date: "2026-06-12", memo: "Processing error, redo" }),
      ],
    ];
    const result = summarizeRentProcessingAccuracy(leaseTransactions, "2026-06-01", "2026-06-30");
    expect(result.paymentCount).toBe(2);
    expect(result.operationalReversalCount).toBe(1);
    expect(result.accuracyPercent).toBe(50);
  });

  it("excludes an NSF-memo reversal from the accuracy percentage but still counts it separately", () => {
    const leaseTransactions = [
      [
        txn({ TransactionType: "Payment", Date: "2026-06-05" }),
        txn({ TransactionType: "Reversed Payment", Date: "2026-06-06", memo: "REVERSED - Balance is not sufficient to cover value of transaction." }),
      ],
    ];
    const result = summarizeRentProcessingAccuracy(leaseTransactions, "2026-06-01", "2026-06-30");
    expect(result.operationalReversalCount).toBe(0);
    expect(result.nsfReversalCount).toBe(1);
    expect(result.accuracyPercent).toBe(100);
  });

  it("classifies a reversal as NSF when within 5 days of an NSF fee, even with a generic memo", () => {
    const leaseTransactions = [
      [
        txn({ TransactionType: "Payment", Date: "2026-06-01" }),
        txn({ TransactionType: "Charge", Date: "2026-06-03", memo: "NSF Fee" }),
        txn({ TransactionType: "Reversed Payment", Date: "2026-06-04", memo: "Reversal" }),
      ],
    ];
    const result = summarizeRentProcessingAccuracy(leaseTransactions, "2026-06-01", "2026-06-30");
    expect(result.nsfReversalCount).toBe(1);
    expect(result.operationalReversalCount).toBe(0);
  });

  it("returns null accuracy when there are no payments in the period", () => {
    const result = summarizeRentProcessingAccuracy([[]], "2026-06-01", "2026-06-30");
    expect(result.paymentCount).toBe(0);
    expect(result.accuracyPercent).toBeNull();
  });

  it("ignores transactions outside the requested date range", () => {
    const leaseTransactions = [
      [txn({ TransactionType: "Payment", Date: "2026-05-15" }), txn({ TransactionType: "Payment", Date: "2026-06-10" })],
    ];
    const result = summarizeRentProcessingAccuracy(leaseTransactions, "2026-06-01", "2026-06-30");
    expect(result.paymentCount).toBe(1);
  });
});

describe("scopeMaintenanceVendors", () => {
  it("scopes to active vendors with a Category.Name starting with Contractor", () => {
    const vendors = [
      vendor({ Id: 1, Category: { Id: 1, Name: "Contractors - HVAC" } }),
      vendor({ Id: 2, Category: { Id: 2, Name: "Restaurants" } }),
      vendor({ Id: 3, IsActive: false, Category: { Id: 1, Name: "Contractors - HVAC" } }),
    ];
    const { scoped, usedFallback } = scopeMaintenanceVendors(vendors);
    expect(scoped.map((v) => v.Id)).toEqual([1]);
    expect(usedFallback).toBe(false);
  });

  it("falls back to all active vendors when no maintenance categories exist", () => {
    const vendors = [vendor({ Id: 1, Category: { Id: 2, Name: "Restaurants" } }), vendor({ Id: 2, Category: { Id: 2, Name: "Suppliers - General" } })];
    const { scoped, usedFallback } = scopeMaintenanceVendors(vendors);
    expect(scoped.length).toBe(2);
    expect(usedFallback).toBe(true);
  });
});

describe("summarizeVendorCompliance", () => {
  it("counts a vendor compliant only with both a TaxPayerId and unexpired insurance", () => {
    const futureDate = new Date();
    futureDate.setFullYear(futureDate.getFullYear() + 1);
    const vendors = [
      vendor({
        Id: 1,
        TaxInformation: { TaxPayerIdType: "SSN", TaxPayerId: "123", IncludeIn1099: false },
        VendorInsurance: { Provider: "X", PolicyNumber: "1", ExpirationDate: futureDate.toISOString().slice(0, 10) },
      }),
      vendor({ Id: 2, TaxInformation: { TaxPayerIdType: null, TaxPayerId: null, IncludeIn1099: false } }),
    ];
    const result = summarizeVendorCompliance(vendors);
    expect(result).toMatchObject({ compliantCount: 1, scopedCount: 2, compliancePercent: 50 });
  });

  it("does not count a vendor with expired insurance as compliant", () => {
    const vendors = [
      vendor({
        Id: 1,
        TaxInformation: { TaxPayerIdType: "SSN", TaxPayerId: "123", IncludeIn1099: false },
        VendorInsurance: { Provider: "X", PolicyNumber: "1", ExpirationDate: "2020-01-01" },
      }),
    ];
    const result = summarizeVendorCompliance(vendors);
    expect(result.compliantCount).toBe(0);
  });
});

describe("summarize1099Compliance", () => {
  it("only counts vendors flagged IncludeIn1099 in the denominator", () => {
    const vendors = [
      vendor({ Id: 1, TaxInformation: { TaxPayerIdType: "SSN", TaxPayerId: "123", IncludeIn1099: true } }),
      vendor({ Id: 2, TaxInformation: { TaxPayerIdType: null, TaxPayerId: null, IncludeIn1099: true } }),
      vendor({ Id: 3, TaxInformation: { TaxPayerIdType: null, TaxPayerId: null, IncludeIn1099: false } }),
    ];
    const result = summarize1099Compliance(vendors);
    expect(result).toMatchObject({ compliantCount: 1, requiringCount: 2, compliancePercent: 50 });
  });
});
