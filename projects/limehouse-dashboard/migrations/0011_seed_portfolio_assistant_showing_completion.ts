import type { MigrationBuilder } from "node-pg-migrate";

// Portfolio Assistant — team_performance: switches on the one KPI of its
// real 3 (per the vendor site: Showing Completion Rate, Property Readiness,
// Resident Response Time — $750 max quarterly bonus, $250/KPI) that
// already has working computation code (summarizeShowingCompletionRate,
// wired into the team-performance-kpis sync job — see
// src/jobs/cacheRefreshJobs.ts). Confirmed live 2026-07-19 that this role
// had ZERO dashboard_kpi_definitions rows at all — never seeded before now.
//
// Property Readiness and Resident Response Time are deliberately NOT
// seeded here (unlike migration 0010's Leasing Specialist pattern, which
// seeded all 3 KPI names up front even before every formula was
// confirmed): both still need Jason to confirm their real data source
// before a source_system value can be chosen honestly — the KPI table UI
// renders a BD/RE/LS badge for every row regardless of whether it has
// data, so a guessed source_system would show a fabricated badge on
// screen. max_bonus_usd is 250 (this KPI's true own share) rather than
// the role's real $750 total, since with only 1 of 3 KPIs seeded the
// per-KPI-max math (max_bonus_usd / KPI count) would otherwise overstate
// it. Bump this row's max_bonus_usd to 750 in the same migration that
// adds the other two.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    `INSERT INTO dashboard_kpi_definitions
       (role, kpi_name, display_group, display_label, target_value, target_operator, unit, higher_is_better, source_system, max_bonus_usd, sort_order)
     VALUES
       ('portfolio_assistant', 'Showing Completion Rate', 'team_performance', 'Portfolio Assistant', 95, '>=', 'percent', true, 'rent_engine', 250, 1)`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    `DELETE FROM dashboard_kpi_definitions WHERE role = 'portfolio_assistant' AND kpi_name = 'Showing Completion Rate'`
  );
}
