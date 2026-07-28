import type { MigrationBuilder } from "node-pg-migrate";

// Widens dashboard_kpi_definitions.source_system from a single value to a
// list — ADDED 2026-07-27, per Jason directly, to unblock Leasing Response
// Time: its real vendor screenshot shows BOTH an RE (RentEngine) and an LS
// (LeadSimple) badge, because the metric genuinely draws from both systems
// (confirmed by Jason directly, not a guess). The schema only allowed one
// value per KPI, which is why that KPI has been left unseeded since
// migration 0013 rather than showing a fabricated single badge.
//
// Every OTHER KPI on the dashboard is still single-source — this migration
// only widens the column type, it doesn't change any existing KPI's real
// badge. The `USING ARRAY[source_system]` cast wraps every existing scalar
// value in a 1-element array, so nothing already seeded needs a data fix.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_source_system");

  pgm.alterColumn("dashboard_kpi_definitions", "source_system", {
    type: "text[]",
    using: "ARRAY[source_system]::text[]",
    notNull: true,
  });

  pgm.addConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_source_system", {
    check:
      "source_system <@ ARRAY['buildium','rent_engine','lead_simple']::text[] AND array_length(source_system, 1) > 0",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_source_system");

  // Collapses back to a single value by taking the first element — safe
  // for every real row at the time this migration was written, since only
  // Leasing Response Time would ever have more than one, and it isn't
  // seeded yet.
  pgm.alterColumn("dashboard_kpi_definitions", "source_system", {
    type: "text",
    using: "source_system[1]",
    notNull: true,
  });

  pgm.addConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_source_system", {
    check: "source_system IN ('buildium','rent_engine','lead_simple')",
  });
}
