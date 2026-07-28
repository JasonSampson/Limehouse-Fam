import type { MigrationBuilder } from "node-pg-migrate";

// Administrative Assistant — team_performance: switches on the one KPI of
// its real 3 (per the vendor site, 2026-07-27: Task Completion Rate,
// Workflow Compliance, Leasing Response Time — $500 max quarterly bonus,
// $166.67/KPI) that has a confirmed formula and working computation code
// (summarizeTaskCompletionRate, wired into the team-performance-kpis sync
// job — see src/leadsimple/client.ts and src/jobs/cacheRefreshJobs.ts).
// Confirmed live 2026-07-27 this role had ZERO dashboard_kpi_definitions
// rows at all — never seeded before now (same starting state Portfolio
// Assistant was in before migration 0011).
//
// Workflow Compliance and Leasing Response Time are deliberately NOT
// seeded here, same reasoning as migration 0011's Property
// Readiness/Resident Response Time: Workflow Compliance's target (>=100%)
// and source (LS) are known from the vendor screenshot but no formula is
// confirmed yet. Leasing Response Time is worse than unconfirmed — its
// screenshot showed BOTH an RE and an LS badge, and source_system only
// allows one value, so seeding it now would mean guessing which single
// badge to show; that needs Jason's input, not a guess. Both will
// correctly show "No data" until confirmed and wired.
//
// max_bonus_usd is 166.67 (this KPI's true own eventual share, $500/3)
// rather than the role's real $500 total, since with only 1 of 3 KPIs
// seeded the per-KPI-max math (max_bonus_usd / KPI count) would otherwise
// overstate it to the full $500. Bump this row's max_bonus_usd to 500 in
// the same migration that adds the other two, same as migration 0012 did
// for Portfolio Assistant.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    `INSERT INTO dashboard_kpi_definitions
       (role, kpi_name, display_group, display_label, target_value, target_operator, unit, higher_is_better, source_system, max_bonus_usd, sort_order)
     VALUES
       ('administrative_assistant', 'Task Completion Rate', 'team_performance', 'Administrative Assistant', 95, '>=', 'percent', true, 'lead_simple', 166.67, 1)`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    `DELETE FROM dashboard_kpi_definitions WHERE role = 'administrative_assistant' AND kpi_name = 'Task Completion Rate'`
  );
}
