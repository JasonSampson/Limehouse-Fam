import type { MigrationBuilder } from "node-pg-migrate";

// Completes Portfolio Assistant's real 3-KPI structure ($750 max quarterly
// bonus, $250/KPI) — Property Readiness and Resident Response Time formulas
// confirmed 2026-07-20, per Jason directly, against real vendor
// screenshots (see src/leadsimple/client.ts's propertyReadinessExplainRows/
// residentResponseTimeExplainRows and src/kpi/businessHours.ts).
//
// Also bumps the Showing Completion Rate row seeded in migration 0011 from
// max_bonus_usd 250 (its own honest share while it was the only KPI
// configured) to 750, matching that migration's own stated plan.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    `UPDATE dashboard_kpi_definitions SET max_bonus_usd = 750
     WHERE role = 'portfolio_assistant' AND kpi_name = 'Showing Completion Rate' AND display_group = 'team_performance'`
  );

  pgm.sql(
    `INSERT INTO dashboard_kpi_definitions
       (role, kpi_name, display_group, display_label, target_value, target_operator, unit, higher_is_better, source_system, max_bonus_usd, sort_order)
     VALUES
       ('portfolio_assistant', 'Property Readiness', 'team_performance', 'Portfolio Assistant', 100, '>=', 'percent', true, 'lead_simple', 750, 2)`
  );
  pgm.sql(
    `INSERT INTO dashboard_kpi_definitions
       (role, kpi_name, display_group, display_label, target_value, target_operator, unit, higher_is_better, source_system, max_bonus_usd, sort_order)
     VALUES
       ('portfolio_assistant', 'Resident Response Time', 'team_performance', 'Portfolio Assistant', 24, '<=', 'hours', false, 'lead_simple', 750, 3)`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    `DELETE FROM dashboard_kpi_definitions WHERE role = 'portfolio_assistant' AND kpi_name IN ('Property Readiness', 'Resident Response Time')`
  );
  pgm.sql(
    `UPDATE dashboard_kpi_definitions SET max_bonus_usd = 250
     WHERE role = 'portfolio_assistant' AND kpi_name = 'Showing Completion Rate' AND display_group = 'team_performance'`
  );
}
