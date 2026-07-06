import { getPool } from "./pool.js";

// Data-access layer over dashboard_financial_history (Neo's migration
// 0008) — the permanent monthly Gross Income / Net Income cache backing
// the CEO View's income charts. See that migration's comments for the full
// rationale on why this is its own table rather than
// dashboard_metric_cache or dashboard_kpi_snapshots.
export type AccountingBasis = "cash" | "accrual";
export type FinancialHistoryStatus = "open" | "closed";

export interface FinancialHistoryRow {
  month: string; // "YYYY-MM"
  monthStart: string; // "YYYY-MM-DD"
  monthEnd: string; // "YYYY-MM-DD"
  year: number;
  grossIncome: number;
  totalExpenses: number;
  netIncome: number;
  accountingBasis: AccountingBasis;
  status: FinancialHistoryStatus;
  fetchedAt: Date;
}

export interface UpsertFinancialHistoryInput {
  month: string;
  monthStart: string;
  monthEnd: string;
  year: number;
  grossIncome: number;
  totalExpenses: number;
  netIncome: number;
  accountingBasis: AccountingBasis;
  status: FinancialHistoryStatus;
}

function toRow(r: any): FinancialHistoryRow {
  return {
    month: r.month,
    monthStart: r.month_start instanceof Date ? r.month_start.toISOString().slice(0, 10) : r.month_start,
    monthEnd: r.month_end instanceof Date ? r.month_end.toISOString().slice(0, 10) : r.month_end,
    year: r.year,
    grossIncome: Number(r.gross_income),
    totalExpenses: Number(r.total_expenses),
    netIncome: Number(r.net_income),
    accountingBasis: r.accounting_basis,
    status: r.status,
    fetchedAt: r.fetched_at,
  };
}

// Every month currently cached, ordered oldest-to-newest — what the CEO
// View's year-over-year chart and monthly breakdown read from. Callers pass
// the accounting basis they want (this project locks in 'cash', per the
// confirmed-live formula in src/kpi/financialSummary.ts, but the column
// exists precisely so this isn't hardcoded at the query layer).
export async function getAllFinancialHistory(accountingBasis: AccountingBasis = "cash"): Promise<FinancialHistoryRow[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT month, month_start, month_end, year, gross_income, total_expenses, net_income, accounting_basis, status, fetched_at
     FROM dashboard_financial_history
     WHERE accounting_basis = $1
     ORDER BY month ASC`,
    [accountingBasis]
  );
  return rows.map(toRow);
}

// Every 'open' row for a basis — what a sync run needs to know it must
// re-fetch (per the migration's status column: only the current
// in-progress month should ever be 'open').
export async function getOpenFinancialHistoryMonths(accountingBasis: AccountingBasis = "cash"): Promise<FinancialHistoryRow[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT month, month_start, month_end, year, gross_income, total_expenses, net_income, accounting_basis, status, fetched_at
     FROM dashboard_financial_history
     WHERE accounting_basis = $1 AND status = 'open'
     ORDER BY month ASC`,
    [accountingBasis]
  );
  return rows.map(toRow);
}

// Which months (as "YYYY-MM" strings) already have ANY row for this basis —
// used by the historical backfill to skip months it's already written,
// rather than re-fetching 100+ months of closed, permanent history on every
// backfill run.
export async function getCachedMonths(accountingBasis: AccountingBasis = "cash"): Promise<Set<string>> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT month FROM dashboard_financial_history WHERE accounting_basis = $1`, [
    accountingBasis,
  ]);
  return new Set(rows.map((r) => r.month));
}

// Writes (or overwrites) one month's figures. A 'closed' row should in
// practice only ever be written once (the sync/backfill logic is
// responsible for not re-requesting closed months — see
// src/buildium/financialHistorySync.ts) but this function itself doesn't
// refuse to overwrite a closed row; enforcing "never re-fetch a closed
// month" is a caller-side/sync-scheduling concern, not a DB-write-time one,
// same division of responsibility dashboard_metric_cache uses (it doesn't
// refuse writes either — callers decide when to call it).
export async function upsertFinancialHistoryMonth(input: UpsertFinancialHistoryInput): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO dashboard_financial_history
       (month, month_start, month_end, year, gross_income, total_expenses, net_income, accounting_basis, status, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (month, accounting_basis) DO UPDATE
       SET month_start = EXCLUDED.month_start,
           month_end = EXCLUDED.month_end,
           year = EXCLUDED.year,
           gross_income = EXCLUDED.gross_income,
           total_expenses = EXCLUDED.total_expenses,
           net_income = EXCLUDED.net_income,
           status = EXCLUDED.status,
           fetched_at = now()`,
    [
      input.month,
      input.monthStart,
      input.monthEnd,
      input.year,
      input.grossIncome,
      input.totalExpenses,
      input.netIncome,
      input.accountingBasis,
      input.status,
    ]
  );
}
