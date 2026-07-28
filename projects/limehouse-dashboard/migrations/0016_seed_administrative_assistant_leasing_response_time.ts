import type { MigrationBuilder } from "node-pg-migrate";

// Administrative Assistant — team_performance: seeds the 3rd and final of
// its real 3 KPIs (per the vendor site, 2026-07-27: Task Completion Rate,
// Workflow Compliance, Leasing Response Time). Leasing Response Time's
// formula is now confirmed against a real vendor drilldown screenshot (see
// summarizeLeasingResponseTime/leasingResponseTimeExplainRows in
// src/leadsimple/client.ts) — its dual RE + LS badge (only possible after
// migration 0015 widened source_system to an array) is per Jason directly:
// the vendor's own site classifies this KPI as spanning both systems, even
// though the formula this codebase can observe reads only LeadSimple data.
//
// max_bonus_usd: all 3 KPIs are now confirmed, so this migration does the
// final bump from the partial-rollout value (333.34, per migration 0014)
// to the role's real $500 total on EVERY row — same "same value on every
// row" invariant documented in migration 0011/0012/0014, now completed for
// this role.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(
    `UPDATE dashboard_kpi_definitions SET max_bonus_usd = 500
     WHERE role = 'administrative_assistant' AND display_group = 'team_performance'
       AND kpi_name IN ('Task Completion Rate', 'Workflow Compliance')`
  );

  pgm.sql(
    `INSERT INTO dashboard_kpi_definitions
       (role, kpi_name, display_group, display_label, target_value, target_operator, unit, higher_is_better, source_system, max_bonus_usd, sort_order)
     VALUES
       ('administrative_assistant', 'Leasing Response Time', 'team_performance', 'Administrative Assistant', 24, '<=', 'hours', false, ARRAY['rent_engine','lead_simple'], 500, 3)`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM dashboard_kpi_definitions WHERE role = 'administrative_assistant' AND kpi_name = 'Leasing Response Time'`);
  pgm.sql(
    `UPDATE dashboard_kpi_definitions SET max_bonus_usd = 333.34
     WHERE role = 'administrative_assistant' AND display_group = 'team_performance'
       AND kpi_name IN ('Task Completion Rate', 'Workflow Compliance')`
  );
}
