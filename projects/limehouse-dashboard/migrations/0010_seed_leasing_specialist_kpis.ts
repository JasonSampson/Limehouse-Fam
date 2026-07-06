import type { MigrationBuilder } from "node-pg-migrate";

// Leasing Specialist — team_performance only (CEO_VIEW_ROLES in
// db/kpiRepository.ts doesn't include this role, confirmed live 2026-07-05).
// $500 max quarterly bonus / 3 KPIs = $166.67 per KPI — confirmed against
// the live vendor site's own "3 KPIs x $167 max each" legend text.
//
// All 3 targets below are read directly off the live vendor dashboard
// (Leasing Specialist card, 2026-07-06): Applicant Response Timeliness
// >=95%, Application Processing Time <=48h, Renewal Follow-Up Timeliness
// >=95%. Seeding all 3 definitions now (even though only 2 have working
// snapshot-computation code so far) keeps the KPI COUNT correct for the
// per-KPI-max math — same pattern as Portfolio Manager's Lease Renewal Rate
// in migration 0009.
//
// Renewal Follow-Up Timeliness's snapshot is intentionally NOT wired yet:
// Jason's description ("Completed tasks in Lease Renewal Process") doesn't
// specify the same "first completed task within 24h" mechanics confirmed
// for Applicant Response Timeliness, and guessing would risk fabricating a
// formula. It will correctly show "No data" until confirmed.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_unit");
  pgm.addConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_unit", {
    check: "unit IN ('percent','currency','days','count','hours')",
  });

  const rows: Array<{
    kpi_name: string;
    target_value: number;
    target_operator: ">=" | "<=";
    unit: "percent" | "hours";
    higher_is_better: boolean;
    source_system: "lead_simple";
    sort_order: number;
  }> = [
    { kpi_name: "Applicant Response Timeliness", target_value: 95, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "lead_simple", sort_order: 1 },
    { kpi_name: "Application Processing Time", target_value: 48, target_operator: "<=", unit: "hours", higher_is_better: false, source_system: "lead_simple", sort_order: 2 },
    { kpi_name: "Renewal Follow-Up Timeliness", target_value: 95, target_operator: ">=", unit: "percent", higher_is_better: true, source_system: "lead_simple", sort_order: 3 },
  ];

  for (const row of rows) {
    pgm.sql(
      `INSERT INTO dashboard_kpi_definitions
         (role, kpi_name, display_group, display_label, target_value, target_operator, unit, higher_is_better, source_system, max_bonus_usd, sort_order)
       VALUES
         ('leasing_specialist', '${row.kpi_name.replace(/'/g, "''")}', 'team_performance', 'Leasing Specialist', ${row.target_value}, '${row.target_operator}', '${row.unit}', ${row.higher_is_better}, '${row.source_system}', 500, ${row.sort_order})`
    );
  }
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    `DELETE FROM dashboard_kpi_definitions WHERE role = 'leasing_specialist' AND kpi_name IN
      ('Applicant Response Timeliness', 'Application Processing Time', 'Renewal Follow-Up Timeliness')`
  );
  pgm.dropConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_unit");
  pgm.addConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_unit", {
    check: "unit IN ('percent','currency','days','count')",
  });
}
