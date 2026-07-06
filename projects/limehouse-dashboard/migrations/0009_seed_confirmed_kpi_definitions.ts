import type { MigrationBuilder } from "node-pg-migrate";

// Seeds the KPI definitions Jason has confirmed real formulas for, as of
// 2026-07-05. Every KPI definition row is seeded even when its SNAPSHOT
// isn't populated yet (Lease Renewal Rate below) — the scoring engine's
// dollar-per-KPI math needs the role's real KPI COUNT to compute the
// correct per-KPI max (e.g. Portfolio Manager's real $250/KPI = $1000 / 4
// KPIs), and a KPI definition with no snapshot row for a period is already
// correctly treated as "no data yet" by getKpiSnapshots()/scoreRole() —
// see db/kpiRepository.ts, same tested pattern already proven for
// Bookkeeper's Reconciliation Accuracy.
//
// NOT seeded here, left for a future migration once confirmed: Property
// Readiness (Portfolio Assistant), the three Leasing Specialist KPIs
// (Applicant Response Timeliness, Application Processing Time, Renewal
// Followup Timeliness — formulas now known but not yet verified against
// live data end-to-end), Leasing Response Time (Administrative Assistant).
// Marketing Specialist stays at zero rows, matching the vendor's own real
// unconfigured state (migration 0002).
export async function up(pgm: MigrationBuilder): Promise<void> {
  const rows: Array<{
    role: string;
    kpi_name: string;
    display_group: "team_performance" | "ceo_view";
    display_label: string;
    target_value: number;
    target_operator: ">=" | "<=";
    unit: "percent" | "currency" | "days" | "count";
    higher_is_better: boolean;
    source_system: "buildium" | "rent_engine" | "lead_simple";
    max_bonus_usd: number;
    sort_order: number;
  }> = [
    // Portfolio Manager — team_performance: 4 KPIs, $1000 max, $250/KPI.
    { role: "portfolio_manager", kpi_name: "Portfolio Occupancy Rate", display_group: "team_performance", display_label: "Portfolio Manager", target_value: 95, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "buildium", max_bonus_usd: 1000, sort_order: 1 },
    { role: "portfolio_manager", kpi_name: "Lease Renewal Rate", display_group: "team_performance", display_label: "Portfolio Manager", target_value: 70, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "lead_simple", max_bonus_usd: 1000, sort_order: 2 },
    { role: "portfolio_manager", kpi_name: "Days on Market", display_group: "team_performance", display_label: "Portfolio Manager", target_value: 21, target_operator: "<=", unit: "days", higher_is_better: false, source_system: "rent_engine", max_bonus_usd: 1000, sort_order: 3 },
    { role: "portfolio_manager", kpi_name: "Delinquency Rate", display_group: "team_performance", display_label: "Portfolio Manager", target_value: 3, target_operator: "<=", unit: "percent", higher_is_better: false, source_system: "buildium", max_bonus_usd: 1000, sort_order: 4 },

    // Portfolio Manager — ceo_view rollup: only 2 of the 4 KPIs (confirmed
    // live 2026-07-05: CEO View's Portfolio Manager card shows Occupancy +
    // Delinquency Rate only, not Renewal Rate or Days on Market).
    { role: "portfolio_manager", kpi_name: "Portfolio Occupancy Rate", display_group: "ceo_view", display_label: "Portfolio Manager", target_value: 95, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "buildium", max_bonus_usd: 1000, sort_order: 1 },
    { role: "portfolio_manager", kpi_name: "Delinquency Rate", display_group: "ceo_view", display_label: "Portfolio Manager", target_value: 3, target_operator: "<=", unit: "percent", higher_is_better: false, source_system: "buildium", max_bonus_usd: 1000, sort_order: 2 },

    // Bookkeeper — team_performance: 4 KPIs, $500 max, $125/KPI.
    { role: "bookkeeper", kpi_name: "Reconciliation Accuracy", display_group: "team_performance", display_label: "Bookkeeper", target_value: 100, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "buildium", max_bonus_usd: 500, sort_order: 1 },
    { role: "bookkeeper", kpi_name: "Rent Processing Accuracy", display_group: "team_performance", display_label: "Bookkeeper", target_value: 100, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "buildium", max_bonus_usd: 500, sort_order: 2 },
    { role: "bookkeeper", kpi_name: "Vendor Compliance", display_group: "team_performance", display_label: "Bookkeeper", target_value: 100, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "buildium", max_bonus_usd: 500, sort_order: 3 },
    // 1099 Compliance's real target is a deadline ("100% by Jan"), not a
    // plain threshold — the scoring engine only supports >=/<= today.
    // Modeled as >=100% for now as a known simplification (flagged in
    // src/kpi/bookkeeperMetrics.ts) until deadline-aware scoring exists.
    { role: "bookkeeper", kpi_name: "1099 Compliance", display_group: "team_performance", display_label: "Bookkeeper", target_value: 100, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "buildium", max_bonus_usd: 500, sort_order: 4 },

    // Bookkeeper — ceo_view rollup, labeled "Bookkeeping Coordinator"
    // there (see kpiRepository.ts's CEO_VIEW_ROLE_DISPLAY_NAME_OVERRIDES) —
    // confirmed live 2026-07-05: same 4 KPIs as team_performance.
    { role: "bookkeeper", kpi_name: "Reconciliation Accuracy", display_group: "ceo_view", display_label: "Bookkeeper", target_value: 100, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "buildium", max_bonus_usd: 500, sort_order: 1 },
    { role: "bookkeeper", kpi_name: "Rent Processing Accuracy", display_group: "ceo_view", display_label: "Bookkeeper", target_value: 100, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "buildium", max_bonus_usd: 500, sort_order: 2 },
    { role: "bookkeeper", kpi_name: "Vendor Compliance", display_group: "ceo_view", display_label: "Bookkeeper", target_value: 100, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "buildium", max_bonus_usd: 500, sort_order: 3 },
    { role: "bookkeeper", kpi_name: "1099 Compliance", display_group: "ceo_view", display_label: "Bookkeeper", target_value: 100, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "buildium", max_bonus_usd: 500, sort_order: 4 },
  ];

  for (const row of rows) {
    pgm.sql(
      `INSERT INTO dashboard_kpi_definitions
         (role, kpi_name, display_group, display_label, target_value, target_operator, unit, higher_is_better, source_system, max_bonus_usd, sort_order)
       VALUES
         ('${row.role}', '${row.kpi_name.replace(/'/g, "''")}', '${row.display_group}', '${row.display_label.replace(/'/g, "''")}', ${row.target_value}, '${row.target_operator}', '${row.unit}', ${row.higher_is_better}, '${row.source_system}', ${row.max_bonus_usd}, ${row.sort_order})`
    );
  }
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    `DELETE FROM dashboard_kpi_definitions WHERE role IN ('portfolio_manager', 'bookkeeper') AND kpi_name IN
      ('Portfolio Occupancy Rate', 'Lease Renewal Rate', 'Days on Market', 'Delinquency Rate',
       'Reconciliation Accuracy', 'Rent Processing Accuracy', 'Vendor Compliance', '1099 Compliance')`
  );
}
