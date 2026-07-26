import { describe, it, expect } from "vitest";
import {
  summarizeReconciliationAccuracy,
  reconciliationAccuracyExplainRows,
  summarizeRentProcessingAccuracy,
  rentProcessingAccuracyExplainRows,
  scopeMaintenanceVendors,
  summarizeVendorCompliance,
  vendorComplianceExplainRows,
  vendorDisplayName,
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
    FirstName: null,
    LastName: null,
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

  // UPDATED 2026-07-26, per Jason directly: previously this counted as a
  // miss for every expected month. Now excluded entirely -- Buildium's API
  // can't confirm an externally-linked account's reconciliation status
  // even though it may genuinely be reconciled (confirmed live: a real
  // 409 "Cannot retrieve reconciliation(s) for an externally linked bank
  // account", while Buildium's own web UI shows real completed
  // reconciliations for that same account) -- scoring it down every month
  // forever would be unfair for a gap in our own visibility, not a real
  // bookkeeping failure.
  it("excludes a not-reconcilable (externally-linked) account entirely, even with a nonzero balance", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Balance: 200 }),
      reconcilable: false,
      reconciliations: [],
    };
    const result = summarizeReconciliationAccuracy([input], "2026-06-01", "2026-06-30");
    expect(result.excludedAccountCount).toBe(1);
    expect(result.scoredAccountCount).toBe(0);
    expect(result.done).toBe(0);
    expect(result.expected).toBe(0);
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

describe("reconciliationAccuracyExplainRows", () => {
  it("reports the most recent finished reconciliation as lastReconciledDate, even outside the period", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Name: "Enterprise- Operating", Balance: 1000 }),
      reconcilable: true,
      reconciliations: [
        { Id: 1, StatementEndingDate: "2026-03-31", IsFinished: true },
        { Id: 2, StatementEndingDate: "2026-06-30", IsFinished: true },
      ],
    };
    const rows = reconciliationAccuracyExplainRows([input], "2026-07-01", "2026-07-05");
    expect(rows[0].lastReconciledDate).toBe("2026-06-30");
  });

  it("reports null lastReconciledDate for an account with no finished reconciliation ever", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Balance: 1000 }),
      reconcilable: true,
      reconciliations: [],
    };
    const rows = reconciliationAccuracyExplainRows([input], "2026-07-01", "2026-07-05");
    expect(rows[0].lastReconciledDate).toBeNull();
  });

  it("computes monthsDone/monthsExpected per account", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Balance: 1000 }),
      reconcilable: true,
      reconciliations: [{ Id: 1, StatementEndingDate: "2026-06-30", IsFinished: true }],
    };
    const rows = reconciliationAccuracyExplainRows([input], "2026-06-01", "2026-07-05");
    expect(rows[0].monthsDone).toBe(1);
    expect(rows[0].monthsExpected).toBe(1); // only June is a fully-completed month in this range
  });

  it("returns monthsExpected 0 when no month in the range has fully closed", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Balance: 1000 }),
      reconcilable: true,
      reconciliations: [],
    };
    const rows = reconciliationAccuracyExplainRows([input], "2026-07-01", "2026-07-05");
    expect(rows[0].monthsDone).toBe(0);
    expect(rows[0].monthsExpected).toBe(0);
  });

  it("marks an externally-linked account excluded and on track, not a miss", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Name: "American Express Credit Card", Balance: -6050.5 }),
      reconcilable: false,
      reconciliations: [],
    };
    const rows = reconciliationAccuracyExplainRows([input], "2026-06-01", "2026-06-30");
    expect(rows[0].excluded).toBe(true);
    expect(rows[0].externallyLinked).toBe(true);
    expect(rows[0].onTrack).toBe(true);
  });

  it("does not mark a $0-balance-excluded account as externallyLinked", () => {
    const input: ReconciliationAccuracyInput = {
      account: bankAccount({ Id: 1, Balance: 0 }),
      reconcilable: true,
      reconciliations: [],
    };
    const rows = reconciliationAccuracyExplainRows([input], "2026-06-01", "2026-06-30");
    expect(rows[0].excluded).toBe(true);
    expect(rows[0].externallyLinked).toBe(false);
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

  // CONFIRMED LIVE 2026-07-26: our real count (208) didn't match the
  // vendor's real, unchanged count (203) on a quiet Sunday morning with no
  // new activity -- traced to 5 real "Payment" transactions whose entire
  // Journal.Lines posted to GL account 5 (Security Deposit Liability), not
  // rent. A deposit isn't rent and shouldn't count toward this KPI at all.
  it("excludes a payment whose entire Journal.Lines is a security deposit, not rent", () => {
    const leaseTransactions = [
      [
        txn({ TransactionType: "Payment", Date: "2026-06-05" }),
        {
          Id: 2,
          LeaseId: 1,
          Date: "2026-06-09",
          TransactionType: "Payment" as const,
          TotalAmount: -1650,
          Journal: { Memo: "Security Deposit", Lines: [{ GLAccount: { Id: 5, Name: "Security Deposit Liability" }, Amount: -1650 }] },
        },
      ],
    ];
    const result = summarizeRentProcessingAccuracy(leaseTransactions, "2026-06-01", "2026-06-30");
    expect(result.paymentCount).toBe(1);
  });

  it("still counts a payment that includes both rent and a non-deposit fee line", () => {
    const leaseTransactions = [
      [
        {
          Id: 1,
          LeaseId: 1,
          Date: "2026-06-05",
          TransactionType: "Payment" as const,
          TotalAmount: -1200,
          Journal: {
            Memo: "by Jane Doe",
            Lines: [
              { GLAccount: { Id: 3, Name: "Rent Income" }, Amount: -1100 },
              { GLAccount: { Id: 8, Name: "Late Fee Income" }, Amount: -100 },
            ],
          },
        },
      ],
    ];
    const result = summarizeRentProcessingAccuracy(leaseTransactions, "2026-06-01", "2026-06-30");
    expect(result.paymentCount).toBe(1);
  });

  it("ignores transactions outside the requested date range", () => {
    const leaseTransactions = [
      [txn({ TransactionType: "Payment", Date: "2026-05-15" }), txn({ TransactionType: "Payment", Date: "2026-06-10" })],
    ];
    const result = summarizeRentProcessingAccuracy(leaseTransactions, "2026-06-01", "2026-06-30");
    expect(result.paymentCount).toBe(1);
  });
});

describe("rentProcessingAccuracyExplainRows", () => {
  it("marks an operational reversal as not-NSF, counted against accuracy", () => {
    const leaseTransactions = [
      [
        txn({ LeaseId: 1, TransactionType: "Payment", Date: "2026-06-05" }),
        txn({ LeaseId: 1, TransactionType: "Reversed Payment", Date: "2026-06-12", TotalAmount: 500, memo: "Processing error, redo" }),
      ],
    ];
    const rows = rentProcessingAccuracyExplainRows(leaseTransactions, "2026-06-01", "2026-06-30");
    expect(rows).toEqual([
      { leaseId: "1", date: "2026-06-12", amount: 500, isOperational: true, category: "Operational reversal — counted against accuracy" },
    ]);
  });

  it("labels an NSF-fee-matched reversal with the confirmed vendor wording", () => {
    const leaseTransactions = [
      [
        txn({ LeaseId: 1, TransactionType: "Payment", Date: "2026-06-01" }),
        txn({ LeaseId: 1, TransactionType: "Charge", Date: "2026-06-03", memo: "NSF Fee" }),
        txn({ LeaseId: 1, TransactionType: "Reversed Payment", Date: "2026-06-04", TotalAmount: 880, memo: "Reversal" }),
      ],
    ];
    const rows = rentProcessingAccuracyExplainRows(leaseTransactions, "2026-06-01", "2026-06-30");
    expect(rows).toEqual([
      { leaseId: "1", date: "2026-06-04", amount: 880, isOperational: false, category: "NSF / bounced rent — informational (matched NSF fee)" },
    ]);
  });

  it("labels a direct-memo-matched NSF reversal distinctly from a fee-matched one", () => {
    const leaseTransactions = [
      [
        txn({ LeaseId: 1, TransactionType: "Payment", Date: "2026-06-05" }),
        txn({ LeaseId: 1, TransactionType: "Reversed Payment", Date: "2026-06-06", TotalAmount: 200, memo: "REVERSED - Balance is not sufficient to cover value of transaction." }),
      ],
    ];
    const rows = rentProcessingAccuracyExplainRows(leaseTransactions, "2026-06-01", "2026-06-30");
    expect(rows[0].category).toBe("NSF / bounced rent — informational (matched NSF memo)");
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
        TaxInformation: { TaxPayerIdType: "SSN", TaxPayerId: "123", IncludeIn1099: true },
        VendorInsurance: { Provider: "X", PolicyNumber: "1", ExpirationDate: futureDate.toISOString().slice(0, 10) },
      }),
      vendor({ Id: 2, TaxInformation: { TaxPayerIdType: null, TaxPayerId: null, IncludeIn1099: true } }),
    ];
    const result = summarizeVendorCompliance(vendors);
    expect(result).toMatchObject({ compliantCount: 1, scopedCount: 2, compliancePercent: 50 });
  });

  it("does not count a vendor with expired insurance as compliant", () => {
    const vendors = [
      vendor({
        Id: 1,
        TaxInformation: { TaxPayerIdType: "SSN", TaxPayerId: "123", IncludeIn1099: true },
        VendorInsurance: { Provider: "X", PolicyNumber: "1", ExpirationDate: "2020-01-01" },
      }),
    ];
    const result = summarizeVendorCompliance(vendors);
    expect(result.compliantCount).toBe(0);
  });

  // ADDED 2026-07-26 per Jason directly: a vendor with Buildium's "Exclude
  // from 1099" box checked (IncludeIn1099: false) doesn't need a tax ID or
  // insurance at all, so it must be scoped out of Vendor Compliance
  // entirely -- not just excluded from the numerator/denominator's
  // "requiring" set the way 1099 Compliance already does it, but dropped
  // from scopedCount too.
  it("excludes a vendor with Exclude from 1099 checked from the scope entirely", () => {
    const vendors = [
      vendor({
        Id: 1,
        TaxInformation: { TaxPayerIdType: "SSN", TaxPayerId: "123", IncludeIn1099: true },
        VendorInsurance: { Provider: "X", PolicyNumber: "1", ExpirationDate: "2099-01-01" },
      }),
      vendor({ Id: 2, TaxInformation: { TaxPayerIdType: null, TaxPayerId: null, IncludeIn1099: false } }),
    ];
    const result = summarizeVendorCompliance(vendors);
    expect(result).toMatchObject({ compliantCount: 1, scopedCount: 1, compliancePercent: 100 });
  });

  // ADDED 2026-07-26 per Jason directly: an individual "RE Contractor (1099
  // Work)" vendor doesn't carry liability insurance for one-off referral
  // work, so a tax ID alone should make them compliant.
  it("counts an RE Contractor (1099 Work) vendor compliant on tax ID alone, no insurance needed", () => {
    const vendors = [
      vendor({
        Id: 1,
        Category: { Id: 71140, Name: "Contractor - RE Contractor (1099 Work)" },
        TaxInformation: { TaxPayerIdType: "SSN", TaxPayerId: "123", IncludeIn1099: true },
        VendorInsurance: { Provider: null, PolicyNumber: null, ExpirationDate: null },
      }),
    ];
    const result = summarizeVendorCompliance(vendors);
    expect(result).toMatchObject({ compliantCount: 1, scopedCount: 1, compliancePercent: 100 });
  });

  it("still requires a tax ID for an RE Contractor (1099 Work) vendor even without insurance", () => {
    const vendors = [
      vendor({
        Id: 1,
        Category: { Id: 71140, Name: "Contractor - RE Contractor (1099 Work)" },
        TaxInformation: { TaxPayerIdType: null, TaxPayerId: null, IncludeIn1099: true },
      }),
    ];
    const result = summarizeVendorCompliance(vendors);
    expect(result.compliantCount).toBe(0);
  });
});

describe("vendorDisplayName", () => {
  it("prefers CompanyName when present", () => {
    expect(vendorDisplayName(vendor({ CompanyName: "Acme LLC", FirstName: "Jane", LastName: "Doe" }))).toBe("Acme LLC");
  });

  // CONFIRMED LIVE 2026-07-26: an individual vendor (e.g. a one-off 1099
  // referral-fee recipient) has CompanyName as an empty string in Buildium,
  // not null -- must fall back to FirstName/LastName, not just `??`.
  it("falls back to FirstName + LastName when CompanyName is an empty string", () => {
    expect(vendorDisplayName(vendor({ CompanyName: "", FirstName: "Jane", LastName: "Doe" }))).toBe("Jane Doe");
  });

  it("falls back to a Vendor #id label when no name is available at all", () => {
    expect(vendorDisplayName(vendor({ Id: 42, CompanyName: "", FirstName: null, LastName: null }))).toBe("Vendor #42");
  });
});

describe("vendorComplianceExplainRows", () => {
  it("sorts rows alphabetically by vendor name", () => {
    const vendors = [
      vendor({ Id: 1, CompanyName: "Zebra Contractors", TaxInformation: { TaxPayerIdType: null, TaxPayerId: null, IncludeIn1099: true } }),
      vendor({ Id: 2, CompanyName: "Atlas Key Shack", TaxInformation: { TaxPayerIdType: null, TaxPayerId: null, IncludeIn1099: true } }),
    ];
    const rows = vendorComplianceExplainRows(vendors);
    expect(rows.map((r) => r.vendorName)).toEqual(["Atlas Key Shack", "Zebra Contractors"]);
  });

  it("excludes a vendor with Exclude from 1099 checked", () => {
    const vendors = [
      vendor({ Id: 1, CompanyName: "Included Co", TaxInformation: { TaxPayerIdType: null, TaxPayerId: null, IncludeIn1099: true } }),
      vendor({ Id: 2, CompanyName: "Excluded Co", TaxInformation: { TaxPayerIdType: null, TaxPayerId: null, IncludeIn1099: false } }),
    ];
    const rows = vendorComplianceExplainRows(vendors);
    expect(rows.map((r) => r.vendorName)).toEqual(["Included Co"]);
  });

  it("reports insuranceCurrent false for an expired policy and true for a future one", () => {
    const vendors = [
      vendor({
        Id: 1,
        CompanyName: "Expired Co",
        TaxInformation: { TaxPayerIdType: "SSN", TaxPayerId: "123", IncludeIn1099: true },
        VendorInsurance: { Provider: "X", PolicyNumber: "1", ExpirationDate: "2020-01-01" },
      }),
      vendor({
        Id: 2,
        CompanyName: "Current Co",
        TaxInformation: { TaxPayerIdType: "SSN", TaxPayerId: "123", IncludeIn1099: true },
        VendorInsurance: { Provider: "X", PolicyNumber: "1", ExpirationDate: "2099-01-01" },
      }),
    ];
    const rows = vendorComplianceExplainRows(vendors);
    const expired = rows.find((r) => r.vendorName === "Expired Co");
    const current = rows.find((r) => r.vendorName === "Current Co");
    expect(expired?.insuranceCurrent).toBe(false);
    expect(current?.insuranceCurrent).toBe(true);
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
