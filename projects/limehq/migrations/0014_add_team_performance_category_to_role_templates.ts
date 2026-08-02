import type { MigrationBuilder } from "node-pg-migrate";

// Optional mapping from a LimeHQ role template to the Dashboard app's
// Team Performance category (dashboard_kpi_definitions.role — a table
// owned by the Dashboard project, in the same shared Supabase Postgres
// instance's public schema; LimeHQ's DATABASE_URL already has read access
// to it). NULL means "this role has no Dashboard KPI category" (e.g.
// Marketing Coordinator). Deliberately just a free-text column, not a FK —
// Dashboard's kpi_definitions.role is not itself constrained to a fixed
// enum/table on that side, and Jason wants this reassignable per role at
// any time without a schema change on either side (see the edit form in
// src/roles/rolesRoutes.ts, which populates the dropdown by querying
// dashboard_kpi_definitions live rather than hardcoding the option list).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("role_templates", {
    team_performance_category: { type: "text" },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("role_templates", "team_performance_category");
}
