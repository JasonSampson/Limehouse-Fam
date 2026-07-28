import type { MigrationBuilder } from "node-pg-migrate";

// Administrative Assistant — team_performance: switches on the 2nd of its
// real 3 KPIs (per the vendor site, 2026-07-27: Task Completion Rate,
// Workflow Compliance, Leasing Response Time — $500 max quarterly bonus,
// $166.67/KPI once all 3 are seeded). Workflow Compliance's formula is now
// confirmed against a real vendor drilldown screenshot (see
// summarizeWorkflowCompliance/workflowComplianceExplainRows in
// src/leadsimple/client.ts).
//
// Leasing Response Time is still deliberately NOT seeded — its screenshot
// showed BOTH an RE and an LS badge, and source_system only allows one
// value, so seeding it now would mean guessing which single badge to show;
// that needs Jason's input, not a guess. It will correctly show "No data"
// until confirmed and wired.
//
// max_bonus_usd: same incremental-rollout pattern as migration 0011/0012
// (Portfolio Assistant) — every row for a role must carry the SAME value
// (it represents the role's current total bonus pool, divided by however
// many KPIs are seeded so far to get each one's fair share). With 1 of 3
// seeded (migration 0013), that value was 166.67 (this KPI's own eventual
// $500/3 share). Now that a 2nd is confirmed, both rows bump to 333.34
// (166.67 * 2) so each of the 2 currently-seeded KPIs still resolves to
// exactly $166.67 (333.34 / 2). The final bump to the full $500 waits for
// Leasing Response Time, same as migration 0012 did for Portfolio
// Assistant's own 3rd KPI.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    `UPDATE dashboard_kpi_definitions SET max_bonus_usd = 333.34
     WHERE role = 'administrative_assistant' AND kpi_name = 'Task Completion Rate' AND display_group = 'team_performance'`
  );

  pgm.sql(
    `INSERT INTO dashboard_kpi_definitions
       (role, kpi_name, display_group, display_label, target_value, target_operator, unit, higher_is_better, source_system, max_bonus_usd, sort_order)
     VALUES
       ('administrative_assistant', 'Workflow Compliance', 'team_performance', 'Administrative Assistant', 100, '>=', 'percent', true, 'lead_simple', 333.34, 2)`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM dashboard_kpi_definitions WHERE role = 'administrative_assistant' AND kpi_name = 'Workflow Compliance'`);
  pgm.sql(
    `UPDATE dashboard_kpi_definitions SET max_bonus_usd = 166.67
     WHERE role = 'administrative_assistant' AND kpi_name = 'Task Completion Rate' AND display_group = 'team_performance'`
  );
}
