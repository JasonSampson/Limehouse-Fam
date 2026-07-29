import type { BuildiumVendor, BuildiumBankAccount, BuildiumReconciliation, BuildiumLeaseTransaction } from "../buildium/client.js";
import { roundPercent } from "../lib/rounding.js";

// ============================================================================
// Reconciliation Accuracy — formula confirmed by Jason 2026-07-05.
// Across active bank accounts, count how many of the fully-completed
// months inside the period have a finished reconciliation. A partial
// current month is never counted (not yet reconcilable). Accounts with
// zero finished reconciliations AND a $0 balance are excluded entirely
// (nothing to reconcile).
//
// UPDATED 2026-07-26, per Jason directly: an account that's NOT
// reconcilable at all via Buildium's API (external-feed/bank-feed-linked
// accounts, e.g. American Express Credit Card — CONFIRMED LIVE via a real
// 409 from Buildium: "Cannot retrieve reconciliation(s) for an externally
// linked bank account") is now excluded from scoring entirely, regardless
// of balance. Previously such an account counted as a miss for every
// expected month once one existed — but Buildium's own web UI (a real
// screenshot Jason showed) confirms these ARE actually being reconciled;
// we simply have no API access to prove it, so it's unfair to score them
// down every month forever for a gap in our own visibility, not a real
// bookkeeping failure.
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
    if (!input.reconcilable) {
      excludedAccountCount++;
      continue;
    }
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

// CONFIRMED LIVE 2026-07-26: Jason reported our count (208) didn't match
// the vendor's real, unchanged number (203) on a quiet Sunday morning —
// ruling out "just live data drift," the explanation used for every other
// small discrepancy so far. Investigated directly: every active lease's
// Payment transactions in the window included exactly 5 whose entire
// Journal.Lines posted to GL account 5 ("Security Deposit Liability"),
// memo literally "Security Deposit" — a deposit isn't rent, and isn't a
// "payment" this KPI should be scoring at all. Excluding those (and any
// symmetric all-deposit reversal, for the same reason) brings the count
// to exactly 203, matching the vendor. Same GL-account-based approach
// already established for RENT_INCOME_GL_ACCOUNT_ID in rentCollection.ts,
// not memo-text matching — a transaction is "deposit-only" if it has at
// least one line and every line hits this account.
const SECURITY_DEPOSIT_LIABILITY_GL_ACCOUNT_ID = 5;

function isSecurityDepositOnly(t: BuildiumLeaseTransaction): boolean {
  const lines = t.Journal?.Lines ?? [];
  return lines.length > 0 && lines.every((l) => l.GLAccount.Id === SECURITY_DEPOSIT_LIABILITY_GL_ACCOUNT_ID);
}

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
    const payments = inPeriod.filter((t) => t.TransactionType === "Payment" && !isSecurityDepositOnly(t));
    const reversals = inPeriod.filter((t) => t.TransactionType === "Reversed Payment" && !isSecurityDepositOnly(t));
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

// ADDED 2026-07-26 per Jason directly, confirmed against Buildium's own
// vendor UI (a vendor's Summary tab, "1099-NEC tax filing" section has a
// real "Exclude from 1099" checkbox). A vendor with that box checked
// doesn't require a tax ID or insurance on file at all per Jason, so it
// shouldn't be counted against Vendor Compliance either way — scoped OUT
// entirely, not just hidden from the drill-down. TaxInformation.IncludeIn1099
// is the real API field behind that checkbox (false = "Exclude from 1099"
// is checked) — same field 1099 Compliance already uses to scope itself
// down to vendors that require a 1099, which is why that KPI didn't need
// this same change.
function excludeMarkedExcludeFrom1099(vendors: BuildiumVendor[]): BuildiumVendor[] {
  return vendors.filter((v) => v.TaxInformation.IncludeIn1099);
}

// A vendor's real display name — CompanyName for a company vendor, else
// FirstName + LastName for an individual (Buildium leaves CompanyName as an
// empty string for those), else a last-resort id so a row is never blank.
export function vendorDisplayName(v: BuildiumVendor): string {
  if (v.CompanyName) return v.CompanyName;
  const personName = [v.FirstName, v.LastName].filter(Boolean).join(" ").trim();
  return personName || `Vendor #${v.Id}`;
}

// CONFIRMED 2026-07-26 per Jason directly: vendors in Buildium's "Contractor
// - RE Contractor (1099 Work)" category are individuals paid a one-off
// referral/1099 fee, not maintenance/trade contractors doing ongoing work on
// a property — they don't carry liability insurance for that kind of work,
// so Vendor Compliance for this one category only requires a tax ID on
// file, not current insurance too.
const NO_INSURANCE_REQUIRED_CATEGORY = "Contractor - RE Contractor (1099 Work)";

function vendorRequiresInsurance(v: BuildiumVendor): boolean {
  return v.Category.Name !== NO_INSURANCE_REQUIRED_CATEGORY;
}

function isVendorCompliant(v: BuildiumVendor, today: Date): boolean {
  if (!v.TaxInformation.TaxPayerId) return false;
  if (!vendorRequiresInsurance(v)) return true;
  return !!v.VendorInsurance.ExpirationDate && new Date(v.VendorInsurance.ExpirationDate) > today;
}

export function summarizeVendorCompliance(vendors: BuildiumVendor[]): VendorComplianceSummary {
  const { scoped: maintenanceScoped, usedFallback } = scopeMaintenanceVendors(vendors);
  const scoped = excludeMarkedExcludeFrom1099(maintenanceScoped);
  const today = new Date();
  const compliant = scoped.filter((v) => isVendorCompliant(v, today));
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
  // insuranceCurrent — carried separately from `compliant` so the frontend
  // can tell "insurance expired" apart from "insurance was never on file"
  // apart from "irrelevant because the tax ID is what's actually missing",
  // using the SAME today-reference this was computed against server-side
  // (avoids the frontend re-deriving its own "today" and drifting a day
  // apart from this at a midnight boundary).
  insuranceCurrent: boolean;
  // insuranceRequired — false for the "RE Contractor (1099 Work)" category
  // (see NO_INSURANCE_REQUIRED_CATEGORY above), so the frontend's reason
  // text doesn't fault a vendor for something this KPI doesn't ask of them.
  insuranceRequired: boolean;
  compliant: boolean;
}

export function vendorComplianceExplainRows(vendors: BuildiumVendor[]): VendorComplianceExplainRow[] {
  const { scoped: maintenanceScoped } = scopeMaintenanceVendors(vendors);
  const scoped = excludeMarkedExcludeFrom1099(maintenanceScoped);
  const today = new Date();
  return scoped
    .map((v) => {
      const hasTaxPayerId = !!v.TaxInformation.TaxPayerId;
      const insuranceExpirationDate = v.VendorInsurance.ExpirationDate;
      const insuranceCurrent = !!insuranceExpirationDate && new Date(insuranceExpirationDate) > today;
      return {
        vendorName: vendorDisplayName(v),
        category: v.Category.Name,
        hasTaxPayerId,
        insuranceExpirationDate,
        insuranceCurrent,
        insuranceRequired: vendorRequiresInsurance(v),
        compliant: isVendorCompliant(v, today),
      };
    })
    .sort((a, b) => a.vendorName.localeCompare(b.vendorName));
}

export interface NineNineComplianceExplainRow {
  vendorName: string;
  category: string | null;
  taxPayerIdType: string | null;
  includeIn1099: boolean;
  hasTaxPayerId: boolean;
  compliant: boolean;
}

export function nineNineComplianceExplainRows(vendors: BuildiumVendor[]): NineNineComplianceExplainRow[] {
  const { scoped } = scopeMaintenanceVendors(vendors);
  return scoped
    .filter((v) => v.TaxInformation.IncludeIn1099)
    .map((v) => ({
      vendorName: vendorDisplayName(v),
      category: v.Category.Name,
      taxPayerIdType: v.TaxInformation.TaxPayerIdType,
      includeIn1099: true,
      hasTaxPayerId: !!v.TaxInformation.TaxPayerId,
      compliant: !!v.TaxInformation.TaxPayerId,
    }))
    .sort((a, b) => a.vendorName.localeCompare(b.vendorName));
}

export interface ReconciliationAccuracyExplainRow {
  accountName: string;
  lastReconciledDate: string | null;
  monthsDone: number;
  monthsExpected: number;
  balance: number;
  // statusDetail — the full internal reasoning (used by the Reconciliation
  // Accuracy Note box to count excluded accounts); NOT what's shown in the
  // table's Status column. Displayed status is just onTrack/excluded,
  // per Jason directly 2026-07-26: "Let's do 'on track'... call it when
  // it's not on track 'Concern'" — a 2-value status, matching the vendor's
  // confirmed "on track" wording for the good case.
  statusDetail: string; // "excluded ($0 balance, nothing to reconcile)" | "no completed month yet this period" | "reconciled" | "not reconciled" | "not reconcilable (external feed)"
  excluded: boolean;
  // externallyLinked — the specific reason within `excluded`, broken out
  // as its own field (rather than string-matching statusDetail) so the
  // Note box can report the two exclusion reasons with separate counts.
  externallyLinked: boolean;
  onTrack: boolean;
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
      const finished = input.reconciliations.filter((r) => r.IsFinished);
      const finishedMonths = new Set(finished.map((r) => r.StatementEndingDate.slice(0, 7)));
      const hasAnyFinished = finishedMonths.size > 0;
      // "Last Reconciled" — ADDED 2026-07-26, per Jason directly, against a
      // real vendor screenshot: the most recent finished reconciliation's
      // statement date across the account's whole history, not just the
      // ones inside this period's expected months.
      const lastReconciledDate =
        finished.length > 0 ? finished.map((r) => r.StatementEndingDate).sort().at(-1)! : null;
      const monthsDone = expectedMonths.filter((m) => finishedMonths.has(m)).length;
      let statusDetail: string;
      let excluded = false;
      let onTrack: boolean;
      // UPDATED 2026-07-26, per Jason directly: externally-linked accounts
      // are excluded from scoring entirely now (see the summarize function's
      // header comment above for why), checked before the $0-balance
      // exclusion so the reason shown is the real one.
      if (!input.reconcilable) {
        statusDetail = "excluded (externally-linked account, can't verify via Buildium's API)";
        excluded = true;
        onTrack = true;
      } else if (!hasAnyFinished && input.account.Balance === 0) {
        statusDetail = "excluded ($0 balance, nothing to reconcile)";
        excluded = true;
        onTrack = true;
      } else if (expectedMonths.length === 0) {
        statusDetail = "no completed month yet this period";
        onTrack = true;
      } else if (expectedMonths.every((m) => finishedMonths.has(m))) {
        statusDetail = "reconciled";
        onTrack = true;
      } else {
        statusDetail = "not reconciled";
        onTrack = false;
      }
      return {
        accountName: input.account.Name ?? `Account #${input.account.Id}`,
        lastReconciledDate,
        monthsDone,
        monthsExpected: expectedMonths.length,
        balance: input.account.Balance,
        statusDetail,
        excluded,
        externallyLinked: !input.reconcilable,
        onTrack,
      };
    })
    // Alphabetical by account name — confirmed against a real vendor
    // screenshot (2026-07-26): American Express Credit Card, Capital One
    // Credit Card, Enterprise- Escrow/Trust, Enterprise- LHPM, Enterprise-
    // Operating is exactly A-Z order, not Buildium's raw account-fetch order.
    .sort((a, b) => a.accountName.localeCompare(b.accountName));
}

export interface RentProcessingAccuracyExplainRow {
  leaseId: string;
  date: string;
  amount: number;
  isOperational: boolean;
  // category — ADDED 2026-07-26, per Jason directly, against a real vendor
  // screenshot: display-ready text for the drill-down's Category column.
  // The NSF wording + "(matched NSF fee)" reason is confirmed live; the
  // "(matched NSF memo)" reason and the operational-reversal wording are
  // NOT yet confirmed against a screenshot (this account has 0 operational
  // reversals right now, and every real NSF example seen so far matched
  // via the fee-proximity rule, not a direct memo match) — built in the
  // same style as a reasonable default, to be corrected if a real example
  // ever shows otherwise.
  category: string;
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
    const reversals = inPeriod.filter((t) => t.TransactionType === "Reversed Payment" && !isSecurityDepositOnly(t));
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
      const category = isNsf
        ? `NSF / bounced rent — informational (matched NSF ${nearNsfFee ? "fee" : "memo"})`
        : "Operational reversal — counted against accuracy";
      rows.push({
        leaseId: String(reversal.LeaseId),
        date: reversal.Date,
        amount: reversal.TotalAmount,
        isOperational: !isNsf,
        category,
      });
    }
  }
  return rows;
}
