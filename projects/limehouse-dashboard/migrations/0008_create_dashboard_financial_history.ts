import type { MigrationBuilder } from "node-pg-migrate";

// Permanent monthly financial history for the CEO View's Gross Income / Net
// Income / Revenue-per-Unit charts, sourced from Buildium's /v1/generalledger
// endpoint (per-GL-account, fetched in <=365-day windows since that's the
// API's max range, then bucketed by calendar month using the same
// income/expense classification as src/kpi/financialSummary.ts).
//
// One row per calendar month, 2018-01 through the current month (~100 rows
// today, +1 every month). This is intentionally NOT dashboard_metric_cache
// (0004) or dashboard_kpi_snapshots (0003):
//   - dashboard_metric_cache is a single-row-per-key, no-history, 10-minute
//     TTL passthrough for live tiles (occupancy, open maintenance requests).
//     Financial history needs 100+ permanent rows, not one row that gets
//     overwritten — wrong shape entirely.
//   - dashboard_kpi_snapshots is scoped to quarterly bonus-scoring KPIs, tied
//     to a kpi_definition_id and carrying score/payout_usd/target_value
//     columns for the Bookkeeper scoring formula. Gross/net income aren't
//     scored KPIs and have no target — forcing this in would mean a bunch of
//     NULL scoring columns that don't mean anything here.
//
// revenue_per_unit is deliberately NOT a column here (not even generated).
// Per how src/api/ceoViewRoutes.ts already works, revenue-per-unit is always
// grossIncome divided by TODAY's active unit count, computed at read time —
// unit count drifts as the portfolio grows/shrinks, and we never want a
// 2018 row's revenue-per-unit locked to 2018's unit count. Storing it here
// would either be wrong the moment units change, or require rewriting every
// historical row on every unit-count change. net_income IS stored (not
// generated) rather than computed at query time, because unlike
// revenue-per-unit it has no time-varying dependency — gross_income and
// total_expenses for a CLOSED month never change, so net_income is exactly
// as permanent as the two numbers it's derived from; storing it plainly
// (instead of as a GENERATED ALWAYS AS column) also lets a future backfill
// correction UPDATE it directly without fighting a generated-column
// restriction.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("dashboard_financial_history", {
    id: "id",
    // "2018-01", "2026-07", etc. Stored as text (not a date) to match the
    // "month" shape already used by src/kpi/financialSummary.ts's
    // MonthlyFinancials.month and src/api/ceoViewRoutes.ts — callers already
    // work with "YYYY-MM" strings, so this avoids a format translation layer
    // at the query boundary. month_start/month_end are also stored (below)
    // for range queries and year-over-year rendering, which text alone
    // can't do efficiently.
    month: { type: "text", notNull: true },
    month_start: { type: "date", notNull: true }, // first day of the month, e.g. 2026-07-01
    month_end: { type: "date", notNull: true }, // last day of the month, e.g. 2026-07-31
    // Calendar year as an integer, denormalized off month_start so the
    // year-over-year chart can index/group by year directly instead of
    // substring-parsing month or date-truncating month_start on every query.
    year: { type: "integer", notNull: true },
    gross_income: { type: "numeric", notNull: true }, // sum of Income-type GL account TotalAmount for the month
    total_expenses: { type: "numeric", notNull: true }, // sum of Expense-type GL account TotalAmount for the month
    net_income: { type: "numeric", notNull: true }, // gross_income - total_expenses; stored plainly, see rationale above
    // 'cash' | 'accrual' — which basis Buildium's /generalledger was queried
    // with to produce this row. This is a real open question (per the build
    // brief: being verified against live vendor numbers), so it's recorded
    // per row rather than assumed globally, letting us tell which basis
    // produced historical numbers and re-derive/re-fetch under the other
    // basis later without ambiguity. Lowercase to match this table's other
    // enum-like columns (status below); source_system columns elsewhere in
    // this schema use lowercase snake_case values for the same reason.
    accounting_basis: { type: "text", notNull: true },
    // The open/closed distinction this table exists to make:
    //   'closed' — the month has fully ended; Buildium's numbers for it are
    //     final and this row is a permanent, permanently-cached record. App
    //     code must NEVER re-fetch or overwrite a closed row.
    //   'open'   — the current in-progress calendar month. Still
    //     accumulating transactions, so app code MUST re-fetch and overwrite
    //     this row on every sync until the month rolls over, at which point
    //     it flips to 'closed' and is written one final time.
    // Modeled as an explicit status column (mirrors dashboard_sync_log's
    // status pattern) rather than reusing dashboard_kpi_snapshots' has_data
    // boolean, because that boolean means "no data exists yet" — a
    // fundamentally different fact from "data exists but is still subject to
    // change." Every month here always has data; what varies is durability.
    status: { type: "text", notNull: true, default: "open" },
    // When this row was last written by a sync. For a 'closed' row this is
    // effectively the row's final-write timestamp (never updated again); for
    // an 'open' row this tells the UI how stale the in-progress month's
    // figures are, same purpose as dashboard_metric_cache.fetched_at.
    fetched_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("dashboard_financial_history", "ck_dashboard_financial_history_accounting_basis", {
    check: "accounting_basis IN ('cash','accrual')",
  });

  pgm.addConstraint("dashboard_financial_history", "ck_dashboard_financial_history_status", {
    check: "status IN ('open','closed')",
  });

  // A month's figures are only ever computed under one basis at a time —
  // re-deriving under the other basis is an explicit, deliberate
  // re-fetch/overwrite of the same row (per the open/closed + fetched_at
  // pattern above), not a second parallel row. One row per (month,
  // accounting_basis) keeps that invariant enforced at the DB level and
  // still allows both bases to coexist historically if we ever backfill both
  // for comparison.
  pgm.addConstraint("dashboard_financial_history", "uq_dashboard_financial_history_month_basis", {
    unique: ["month", "accounting_basis"],
  });

  // month_end must not precede month_start, and year must actually match
  // month_start's year — cheap sanity checks against a bad backfill writing
  // a mismatched month/year/date combination.
  pgm.addConstraint("dashboard_financial_history", "ck_dashboard_financial_history_month_range", {
    check: "month_end >= month_start AND year = EXTRACT(YEAR FROM month_start)::int",
  });

  // Lookup by month, for the CEO View's monthly breakdown (also serves the
  // uq_dashboard_financial_history_month_basis lookup path).
  pgm.createIndex("dashboard_financial_history", ["month"], {
    name: "idx_dashboard_financial_history_month",
  });

  // Lookup by year, for year-over-year chart rendering.
  pgm.createIndex("dashboard_financial_history", ["year"], {
    name: "idx_dashboard_financial_history_year",
  });

  // Lets a sync job cheaply find the one (or few) 'open' rows it needs to
  // re-fetch without scanning the full ~100+ closed history every run.
  pgm.createIndex("dashboard_financial_history", ["status"], {
    name: "idx_dashboard_financial_history_status",
  });

  pgm.createTrigger("dashboard_financial_history", "trg_set_updated_at_dashboard_financial_history", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("dashboard_financial_history", "trg_set_updated_at_dashboard_financial_history");
  pgm.dropTable("dashboard_financial_history");
}
