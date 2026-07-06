import type { BuildiumVendor, BuildiumBankAccount, BuildiumReconciliation, BuildiumLeaseTransaction } from "../buildium/client.js";

function roundPercent(n: number): number {
  return Math.round(n * 10) / 10;
}

// ============================================================================
// Reconciliation Accuracy — formula confirmed by Jason 2026-07-05.
// Across active bank accounts, count how many of the fully-completed
// months inside the period have a finished reconciliation. A partial
// current month is never counted (not yet reconcilable). Accounts with
// zero finished reconciliations AND a $0 balance are excluded entirely
// (nothing to reconcile). An account that's NOT reconcilable at all
// (external-feed accounts, e.g. some credit cards — CONFIRMED LIVE via a
// real 409 from Buildium) is treated the same as "zero reconciliations":
// excluded only if its balance is also $0, otherwise counts as a miss for
// every expected month, same as any other account with no reconciliation.
export interface ReconciliationAccuracyInput {
  account: BuildiumBankAccount;
  reconcilable: boolean;
  reconciliations: BuildiumReconciliation[];
}

export interface ReconciliationAccuracySummary {
  accuracyPercent: number | null;
  done: number;
  expected: number;
  excludedAccountCount: number;
  scoredAccountCount: number;
}

function completedMonthsInRange(fromDate: string, toDate: string): string[] {
  const months: string[] = [];
  const from = new Date(fromDate + "T00:00:00Z");
  const to = new Date(toDate + "T00:00:00Z");
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cursor <= to) {
    const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    if (monthEnd <= to) {
      months.push(cursor.toISOString().slice(0, 7));
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export function summarizeReconciliationAccuracy(
  inputs: ReconciliationAccuracyInput[],
  fromDate: string,
  toDate: string
): ReconciliationAccuracySummary {
  const expectedMonths = completedMonthsInRange(fromDate, toDate);
  const active = inputs.filter((i) => i.account.IsActive);

  let done = 0;
  let expected = 0;
  let excludedAccountCount = 0;
  let scoredAccountCount = 0;

  for (const input of active) {
    const finishedMonths = new Set(
      input.reconciliations.filter((r) => r.IsFinished).map((r) => r.StatementEndingDate.slice(0, 7))
    );
    const hasAnyFinished = finishedMonths.size > 0;
    if (!hasAnyFinished && input.account.Balance === 0) {
      excludedAccountCount++;
      continue;
    }
    scoredAccountCount++;
    for (const month of expectedMonths) {
      expected++;
      if (finishedMonths.has(month)) done++;
    }
  }

  return {
    accuracyPercent: expected > 0 ? roundPercent((done / expected) * 100) : null,
    done,
    expected,
    excludedAccountCount,
    scoredAccountCount,
  };
}

// ============================================================================
// Rent Processing Accuracy — formula confirmed by Jason 2026-07-05.
// 1 - (operational ReversePayment count / Payment count), across active
// leases, within the period. Buildium's real TransactionType string for a
// reversal is "Reversed Payment" (past tense, with a space) — CONFIRMED
// LIVE 2026-07-05, not "ReversePayment" as the TransactionTypeEnum name
// suggests. NSF/bounced/etc. reversals are tenant-driven, not a processing
// error, and are excluded from the accuracy % (but still counted/returned
// separately as informational).
// CONFIRMED LIVE 2026-07-05: a real reversal memo reads "Balance is not
// sufficient to cover value of transaction" — "not sufficient", not the
// single word "insufficient" — so the pattern must match both phrasings.
const NSF_MEMO_PATTERN = /nsf|returned|bounced|insufficient|not sufficient|chargeback|declined/i;
const NSF_FEE_WINDOW_DAYS = 5;

export interface RentProcessingAccuracySummary {
  accuracyPercent: number | null;
  paymentCount: number;
  operationalReversalCount: number;
  nsfReversalCount: number;
}

export function summarizeRentProcessingAccuracy(
  transactionsByLease: BuildiumLeaseTransaction[][],
  fromDate: string,
  toDate: string
): RentProcessingAccuracySummary {
  const from = new Date(fromDate + "T00:00:00Z");
  const to = new Date(toDate + "T23:59:59Z");
  const inRange = (dateStr: string) => {
    const d = new Date(dateStr);
    return d >= from && d <= to;
  };

  let paymentCount = 0;
  let operationalReversalCount = 0;
  let nsfReversalCount = 0;

  for (const transactions of transactionsByLease) {
    const inPeriod = transactions.filter((t) => inRange(t.Date));
    const payments = inPeriod.filter((t) => t.TransactionType === "Payment");
    const reversals = inPeriod.filter((t) => t.TransactionType === "Reversed Payment");
    const nsfFeeDates = inPeriod
      .filter((t) => /nsf/i.test(t.Journal?.Memo ?? ""))
      .map((t) => new Date(t.Date).getTime());

    paymentCount += payments.length;

    for (const reversal of reversals) {
      const memo = reversal.Journal?.Memo ?? "";
      const memoMatchesNsf = NSF_MEMO_PATTERN.test(memo);
      const reversalTime = new Date(reversal.Date).getTime();
      const nearNsfFee = nsfFeeDates.some(
        (feeTime) => Math.abs(feeTime - reversalTime) <= NSF_FEE_WINDOW_DAYS * 24 * 60 * 60 * 1000
      );
      if (memoMatchesNsf || nearNsfFee) {
        nsfReversalCount++;
      } else {
        operationalReversalCount++;
      }
    }
  }

  const accuracyPercent = paymentCount > 0 ? roundPercent((1 - operationalReversalCount / paymentCount) * 100) : null;

  return { accuracyPercent, paymentCount, operationalReversalCount, nsfReversalCount };
}

// ============================================================================
// Vendor Compliance / 1099 Compliance — formulas confirmed by Jason
// 2026-07-05, CONFIRMED LIVE against real Buildium vendor data: Vendor
// Compliance = 56.4% (31/55), 1099 Compliance = 81.8% (45/55) — exact
// matches to the vendor's real displayed figures for this account today.
export interface VendorScopeSummary {
  scopedVendorCount: number;
  usedFallbackToAllActive: boolean;
}

export function scopeMaintenanceVendors(vendors: BuildiumVendor[]): { scoped: BuildiumVendor[]; usedFallback: boolean } {
  const active = vendors.filter((v) => v.IsActive);
  const maintenance = active.filter((v) => v.Category.Name?.startsWith("Contractor"));
  if (maintenance.length > 0) {
    return { scoped: maintenance, usedFallback: false };
  }
  return { scoped: active, usedFallback: true };
}

export interface VendorComplianceSummary {
  compliancePercent: number | null;
  compliantCount: number;
  scopedCount: number;
  usedFallbackToAllActive: boolean;
}

export function summarizeVendorCompliance(vendors: BuildiumVendor[]): VendorComplianceSummary {
  const { scoped, usedFallback } = scopeMaintenanceVendors(vendors);
  const today = new Date();
  const compliant = scoped.filter(
    (v) =>
      !!v.TaxInformation.TaxPayerId &&
      !!v.VendorInsurance.ExpirationDate &&
      new Date(v.VendorInsurance.ExpirationDate) > today
  );
  return {
    compliancePercent: scoped.length > 0 ? roundPercent((compliant.length / scoped.length) * 100) : null,
    compliantCount: compliant.length,
    scopedCount: scoped.length,
    usedFallbackToAllActive: usedFallback,
  };
}

export interface NineNineComplianceSummary {
  compliancePercent: number | null;
  compliantCount: number;
  requiringCount: number;
  usedFallbackToAllActive: boolean;
}

export function summarize1099Compliance(vendors: BuildiumVendor[]): NineNineComplianceSummary {
  const { scoped, usedFallback } = scopeMaintenanceVendors(vendors);
  const requiring = scoped.filter((v) => v.TaxInformation.IncludeIn1099);
  const compliant = requiring.filter((v) => !!v.TaxInformation.TaxPayerId);
  return {
    compliancePercent: requiring.length > 0 ? roundPercent((compliant.length / requiring.length) * 100) : null,
    compliantCount: compliant.length,
    requiringCount: requiring.length,
    usedFallbackToAllActive: usedFallback,
  };
}

// ============================================================================
// "Explain" row builders — the per-record detail behind each KPI's
// percentage, for the Team Performance KPI drill-down (click a KPI, see
// the real data that produced the number, matching the vendor site's own
// "tap any KPI to see the data behind it" pattern).
export interface VendorComplianceExplainRow {
  vendorName: string;
  category: string | null;
  hasTaxPayerId: boolean;
  insuranceExpirationDate: string | null;
  compliant: boolean;
}

export function vendorComplianceExplainRows(vendors: BuildiumVendor[]): VendorComplianceExplainRow[] {
  const { scoped } = scopeMaintenanceVendors(vendors);
  const today = new Date();
  return scoped.map((v) => {
    const hasTaxPayerId = !!v.TaxInformation.TaxPayerId;
    const insuranceExpirationDate = v.VendorInsurance.ExpirationDate;
    const insuranceCurrent = !!insuranceExpirationDate && new Date(insuranceExpirationDate) > today;
    return {
      vendorName: v.CompanyName ?? `Vendor #${v.Id}`,
      category: v.Category.Name,
      hasTaxPayerId,
      insuranceExpirationDate,
      compliant: hasTaxPayerId && insuranceCurrent,
    };
  });
}

export interface NineNineComplianceExplainRow {
  vendorName: string;
  category: string | null;
  includeIn1099: boolean;
  hasTaxPayerId: boolean;
  compliant: boolean;
}

export function nineNineComplianceExplainRows(vendors: BuildiumVendor[]): NineNineComplianceExplainRow[] {
  const { scoped } = scopeMaintenanceVendors(vendors);
  return scoped
    .filter((v) => v.TaxInformation.IncludeIn1099)
    .map((v) => ({
      vendorName: v.CompanyName ?? `Vendor #${v.Id}`,
      category: v.Category.Name,
      includeIn1099: true,
      hasTaxPayerId: !!v.TaxInformation.TaxPayerId,
      compliant: !!v.TaxInformation.TaxPayerId,
    }));
}

export interface ReconciliationAccuracyExplainRow {
  accountName: string;
  balance: number;
  status: string; // "excluded ($0 balance, nothing to reconcile)" | "reconciled" | "not reconciled" | "not reconcilable (external feed)"
}

export function reconciliationAccuracyExplainRows(
  inputs: ReconciliationAccuracyInput[],
  fromDate: string,
  toDate: string
): ReconciliationAccuracyExplainRow[] {
  const expectedMonths = completedMonthsInRange(fromDate, toDate);
  return inputs
    .filter((i) => i.account.IsActive)
    .map((input) => {
      const finishedMonths = new Set(
        input.reconciliations.filter((r) => r.IsFinished).map((r) => r.StatementEndingDate.slice(0, 7))
      );
      const hasAnyFinished = finishedMonths.size > 0;
      let status: string;
      if (!hasAnyFinished && input.account.Balance === 0) {
        status = "excluded ($0 balance, nothing to reconcile)";
      } else if (expectedMonths.length === 0) {
        status = "no completed month yet this period";
      } else if (!input.reconcilable) {
        status = "not reconcilable (externally-linked account)";
      } else if (expectedMonths.every((m) => finishedMonths.has(m))) {
        status = "reconciled";
      } else {
        status = "not reconciled";
      }
      return { accountName: input.account.Name ?? `Account #${input.account.Id}`, balance: input.account.Balance, status };
    });
}

export interface RentProcessingAccuracyExplainRow {
  leaseId: string;
  date: string;
  amount: number;
  classification: "operational reversal" | "NSF (excluded)";
  memo: string | null;
}

export function rentProcessingAccuracyExplainRows(
  transactionsByLease: BuildiumLeaseTransaction[][],
  fromDate: string,
  toDate: string
): RentProcessingAccuracyExplainRow[] {
  const from = new Date(fromDate + "T00:00:00Z");
  const to = new Date(toDate + "T23:59:59Z");
  const inRange = (dateStr: string) => {
    const d = new Date(dateStr);
    return d >= from && d <= to;
  };
  const rows: RentProcessingAccuracyExplainRow[] = [];
  for (const transactions of transactionsByLease) {
    const inPeriod = transactions.filter((t) => inRange(t.Date));
    const reversals = inPeriod.filter((t) => t.TransactionType === "Reversed Payment");
    const nsfFeeDates = inPeriod
      .filter((t) => /nsf/i.test(t.Journal?.Memo ?? ""))
      .map((t) => new Date(t.Date).getTime());
    for (const reversal of reversals) {
      const memo = reversal.Journal?.Memo ?? "";
      const memoMatchesNsf = NSF_MEMO_PATTERN.test(memo);
      const reversalTime = new Date(reversal.Date).getTime();
      const nearNsfFee = nsfFeeDates.some(
        (feeTime) => Math.abs(feeTime - reversalTime) <= NSF_FEE_WINDOW_DAYS * 24 * 60 * 60 * 1000
      );
      const isNsf = memoMatchesNsf || nearNsfFee;
      rows.push({
        leaseId: String(reversal.LeaseId),
        date: reversal.Date,
        amount: reversal.TotalAmount,
        classification: isNsf ? "NSF (excluded)" : "operational reversal",
        memo: reversal.Journal?.Memo ?? null,
      });
    }
  }
  return rows;
}
