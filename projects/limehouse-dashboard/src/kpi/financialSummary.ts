import type { BuildiumGeneralLedgerAccount, BuildiumGlAccount } from "../buildium/client.js";
import { roundCurrency } from "../lib/rounding.js";

// Derives Gross Income / Net Income / Revenue-per-Unit from Buildium's real
// /v1/generalledger endpoint (see src/buildium/client.ts's
// fetchGeneralLedgerTotals for the confirmed endpoint/param details) plus
// the chart of accounts, since Buildium has no single endpoint that returns
// these as named figures directly.
//
// CONFIRMED LIVE 2026-07-05 against Jason's real Buildium account and real
// CEO View numbers (Jan-Jun 2026 monthly + Jul 1-5 2026 partial, all
// matched to the penny):
//   Gross Income = sum of TotalAmount across every GL account of Type
//     'Income', scoped to entitytype=Company&entityid=<Limehouse's own
//     Company entity> (see fetchGeneralLedgerTotals), accountingbasis=Cash.
//   Net Income = Gross Income - sum of TotalAmount across every GL account
//     of Type 'Expense', same scope/basis.
// TotalAmount from /generalledger is already the correct signed net change
// for that account over the range — no PostingType debit/credit
// sign-flipping is needed (unlike the old, wrong /glentries-based
// approach), since /generalledger pre-aggregates per account.
//
// Revenue per Unit = Gross Income for the month / the CURRENT active
// residential unit count (src/buildium/client.ts's
// fetchActiveResidentialUnits()), NOT Net Income and NOT a historical unit
// count for that month — confirmed against Jason's real "$462 last month"
// figure: Gross Income for June 2026 ($108,007.18) divided by the real live
// active-residential-unit count (233, at the time this was verified) gives
// $463.55, matching to within normal unit-count drift (a unit or two
// turning over between when Jason's screenshot was taken and when this was
// verified) — dividing by Net Income instead gives $176.29, nowhere close.
export interface MonthlyFinancials {
  month: string; // "YYYY-MM"
  grossIncome: number;
  totalExpenses: number;
  netIncome: number;
}

// Classifies the chart of accounts once into the Income/Expense account ID
// lists fetchGeneralLedgerTotals needs. Accounts of any other Type (Asset,
// Liability, Equity) are intentionally excluded — they are not part of
// Gross/Net Income (e.g. Accounts Receivable, Security Deposit Liability,
// Owner Draw).
export interface ClassifiedGlAccountIds {
  incomeAccountIds: number[];
  expenseAccountIds: number[];
}

export function classifyGlAccountIds(glAccountsById: Map<number, BuildiumGlAccount>): ClassifiedGlAccountIds {
  const incomeAccountIds: number[] = [];
  const expenseAccountIds: number[] = [];
  for (const account of glAccountsById.values()) {
    if (account.Type === "Income") incomeAccountIds.push(account.Id);
    else if (account.Type === "Expense") expenseAccountIds.push(account.Id);
  }
  return { incomeAccountIds, expenseAccountIds };
}

function sumTotalAmount(rows: BuildiumGeneralLedgerAccount[]): number {
  return roundCurrency(rows.reduce((sum, row) => sum + row.TotalAmount, 0));
}

// Computes Gross Income / Net Income for a single date range (e.g. one
// calendar month, or a YTD range) from already-fetched GL totals — pure
// function, no network calls, so it's easy to test and easy to reuse for
// both the monthly breakdown and YTD/coverage-range summaries.
export function summarizeFinancials(
  incomeRows: BuildiumGeneralLedgerAccount[],
  expenseRows: BuildiumGeneralLedgerAccount[]
): { grossIncome: number; totalExpenses: number; netIncome: number } {
  const grossIncome = sumTotalAmount(incomeRows);
  const totalExpenses = sumTotalAmount(expenseRows);
  return {
    grossIncome,
    totalExpenses,
    netIncome: roundCurrency(grossIncome - totalExpenses),
  };
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
// than it does. Looks at the earliest Entries[] date across the given GL
// account rows (Income accounts are sufficient/representative for this
// check — Rent Income alone reliably has activity in every real month).
export interface GlHistoryCoverage {
  requestedFrom: string;
  earliestEntryDate: string | null;
  fullyCovered: boolean;
}

export function checkGlHistoryCoverage(
  incomeRows: BuildiumGeneralLedgerAccount[],
  requestedFrom: string
): GlHistoryCoverage {
  let earliest: string | null = null;
  for (const row of incomeRows) {
    for (const entry of row.Entries) {
      if (earliest === null || entry.Date < earliest) earliest = entry.Date;
    }
  }
  if (earliest === null) {
    return { requestedFrom, earliestEntryDate: null, fullyCovered: false };
  }
  return {
    requestedFrom,
    earliestEntryDate: earliest,
    fullyCovered: earliest <= requestedFrom,
  };
}

