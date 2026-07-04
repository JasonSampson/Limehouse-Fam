import type { BuildiumGlAccount, BuildiumGlEntry } from "../buildium/client.js";

// Derives monthly Gross Income / Net Income / Revenue-per-Unit from raw GL
// journal entries + the chart of accounts, since Buildium has no single
// endpoint that returns these as named figures directly (see the research
// note in src/buildium/client.ts above fetchGlEntries). Classification
// follows the same pattern late-rent-notices already uses for itemized
// charges: resolve each line's GLAccountId against the chart of accounts,
// then bucket by the account's Type (Income / Expense).
//
// Gross Income = sum of all Income-type GL lines (credits, since income
//   accounts increase on the credit side in double-entry accounting).
// Net Income = Gross Income - sum of all Expense-type GL lines (debits).
// Revenue per Unit = Gross Income / unit count for that month, computed by
//   the caller (this module doesn't know the unit count).
//
// UNVERIFIED ASSUMPTION, flagged per the build brief's discipline: this
// assumes Buildium's PostingType convention is standard double-entry
// (Income accounts credited to increase, Expense accounts debited to
// increase) — matches every general ledger system Buildium's docs describe
// itself as compatible with, but has NOT been confirmed against a live
// glentries response for this account. Verify sign conventions against a
// real response before trusting these numbers in production.
export interface MonthlyFinancials {
  month: string; // "YYYY-MM"
  grossIncome: number;
  totalExpenses: number;
  netIncome: number;
}

export function summarizeMonthlyFinancials(
  entries: BuildiumGlEntry[],
  glAccountsById: Map<number, BuildiumGlAccount>
): MonthlyFinancials[] {
  const byMonth = new Map<string, { income: number; expense: number }>();

  for (const entry of entries) {
    const month = entry.Date.slice(0, 7); // "YYYY-MM-DD" -> "YYYY-MM"
    const bucket = byMonth.get(month) ?? { income: 0, expense: 0 };

    for (const line of entry.Lines) {
      const account = glAccountsById.get(line.GlAccountId);
      if (!account) continue; // unresolvable GL account — skip rather than misclassify

      const signedAmount = line.PostingType === "Credit" ? line.Amount : -line.Amount;

      if (account.Type === "Income") {
        bucket.income += signedAmount;
      } else if (account.Type === "Expense") {
        // Expenses increase on the debit side; flip sign so "expense" is
        // reported as a positive dollar figure for display purposes.
        bucket.expense += -signedAmount;
      }
    }

    byMonth.set(month, bucket);
  }

  return [...byMonth.entries()]
    .map(([month, { income, expense }]) => ({
      month,
      grossIncome: roundCurrency(income),
      totalExpenses: roundCurrency(expense),
      netIncome: roundCurrency(income - expense),
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

export interface RevenuePerUnitInput {
  month: string;
  grossIncome: number;
  unitCount: number;
}

export function revenuePerUnit({ grossIncome, unitCount }: RevenuePerUnitInput): number | null {
  if (unitCount <= 0) return null; // avoid divide-by-zero; caller shows "n/a"
  return roundCurrency(grossIncome / unitCount);
}

// Checks whether the requested date range is actually fully covered by the
// data Buildium returned, so callers can report an honest earliest-data
// date to the user rather than silently pretend history goes back further
// than it does (per the build brief: "If GL history doesn't actually go
// back to 2018... note that clearly rather than silently truncating").
export interface GlHistoryCoverage {
  requestedFrom: string;
  earliestEntryDate: string | null;
  fullyCovered: boolean;
}

export function checkGlHistoryCoverage(entries: BuildiumGlEntry[], requestedFrom: string): GlHistoryCoverage {
  if (entries.length === 0) {
    return { requestedFrom, earliestEntryDate: null, fullyCovered: false };
  }
  const earliest = entries.reduce((min, e) => (e.Date < min ? e.Date : min), entries[0].Date);
  return {
    requestedFrom,
    earliestEntryDate: earliest,
    fullyCovered: earliest <= requestedFrom,
  };
}

function roundCurrency(n: number): number {
  return Math.round(n * 100) / 100;
}
