import { fetchGeneralLedgerTotals, fetchGlAccountsById } from "./client.js";
import { classifyGlAccountIds, summarizeFinancials } from "../kpi/financialSummary.js";
import { getCachedMonths, upsertFinancialHistoryMonth, type AccountingBasis } from "../db/financialHistory.js";

// Backfills/refreshes src/db/financialHistory.ts's dashboard_financial_history
// table, one calendar month at a time, from Buildium's real /generalledger
// endpoint — following the confirmed-live formula in
// src/kpi/financialSummary.ts (Income/Expense accounts, scoped to
// Limehouse's own Company entity, Cash basis).
//
// Caching discipline (per the build brief): a CLOSED month's Gross/Net
// Income never changes once the month has ended, so this only re-fetches
// months that are either (a) not cached yet at all (the historical
// backfill's job) or (b) the current, still-open calendar month (every
// sync's job, every time, until it rolls over and gets marked 'closed' on
// its final write). This is why syncFinancialHistory below always
// re-fetches the current month regardless of cache state, but skips any
// past month already present in the cache.
export const ACCOUNTING_BASIS: AccountingBasis = "cash"; // confirmed live 2026-07-05, see financialSummary.ts

const EARLIEST_HISTORY_MONTH = "2018-01"; // per the build brief; real data confirmed to exist back to at least this month

export interface MonthWindow {
  month: string; // "YYYY-MM"
  monthStart: string; // "YYYY-MM-DD"
  monthEnd: string; // "YYYY-MM-DD"
  year: number;
  isCurrentMonth: boolean;
}

// Every calendar month from EARLIEST_HISTORY_MONTH through the month
// containing `now`, oldest first. Exported for testing the enumeration
// logic in isolation from any network/DB calls.
export function enumerateMonthsThrough(now: Date): MonthWindow[] {
  const months: MonthWindow[] = [];
  const [startYear, startMonth] = EARLIEST_HISTORY_MONTH.split("-").map(Number);
  let cursor = new Date(Date.UTC(startYear, startMonth - 1, 1));
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  while (cursor <= currentMonthStart) {
    const year = cursor.getUTCFullYear();
    const monthIndex = cursor.getUTCMonth();
    const monthStartDate = new Date(Date.UTC(year, monthIndex, 1));
    const monthEndDate = new Date(Date.UTC(year, monthIndex + 1, 0));
    // Clamp the end of the CURRENT month to today, matching this project's
    // existing "current period never reaches into the future" convention
    // (src/kpi/period.ts's clampEnd) — Buildium has no data for days that
    // haven't happened yet, and we don't want a future-dated query range.
    const isCurrentMonth = monthIndex === now.getUTCMonth() && year === now.getUTCFullYear();
    const clampedEnd = isCurrentMonth && monthEndDate > now ? now : monthEndDate;

    months.push({
      month: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
      monthStart: toDateString(monthStartDate),
      monthEnd: toDateString(clampedEnd),
      year,
      isCurrentMonth,
    });

    cursor = new Date(Date.UTC(year, monthIndex + 1, 1));
  }

  return months;
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface FinancialHistorySyncResult {
  monthsWritten: number;
  monthsSkipped: number; // already-cached closed months, left untouched
}

// Runs the sync: fetches the chart of accounts once, figures out which
// months actually need a Buildium call (uncached months + the always-live
// current month), fetches each one's GL totals, and writes the result.
// Sequential per month (not Promise.all) — deliberately slow on a full
// 2018-2026 backfill, same rate-limit discipline this project already
// applies to other multi-call Buildium syncs (see syncRoutes.ts's
// rent-collection sync comment) — a one-time/periodic backfill job taking
// several minutes is an acceptable trade against risking a 429 burst.
export async function syncFinancialHistory(now: Date = new Date()): Promise<FinancialHistorySyncResult> {
  const glAccountsById = await fetchGlAccountsById();
  const { incomeAccountIds, expenseAccountIds } = classifyGlAccountIds(glAccountsById);

  const allMonths = enumerateMonthsThrough(now);
  const cachedMonths = await getCachedMonths(ACCOUNTING_BASIS);

  let monthsWritten = 0;
  let monthsSkipped = 0;

  for (const monthWindow of allMonths) {
    // Skip any past month already cached — closed months are permanent.
    // The current month is NEVER skipped, even if a stale 'open' row for
    // it already exists, since it's still accumulating transactions.
    if (!monthWindow.isCurrentMonth && cachedMonths.has(monthWindow.month)) {
      monthsSkipped++;
      continue;
    }

    const [incomeRows, expenseRows] = await Promise.all([
      fetchGeneralLedgerTotals(incomeAccountIds, monthWindow.monthStart, monthWindow.monthEnd, "Cash"),
      fetchGeneralLedgerTotals(expenseAccountIds, monthWindow.monthStart, monthWindow.monthEnd, "Cash"),
    ]);

    const { grossIncome, totalExpenses, netIncome } = summarizeFinancials(incomeRows, expenseRows);

    await upsertFinancialHistoryMonth({
      month: monthWindow.month,
      monthStart: monthWindow.monthStart,
      monthEnd: monthWindow.monthEnd,
      year: monthWindow.year,
      grossIncome,
      totalExpenses,
      netIncome,
      accountingBasis: ACCOUNTING_BASIS,
      status: monthWindow.isCurrentMonth ? "open" : "closed",
    });
    monthsWritten++;
  }

  return { monthsWritten, monthsSkipped };
}
