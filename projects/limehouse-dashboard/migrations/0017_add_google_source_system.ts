import type { MigrationBuilder } from "node-pg-migrate";

// Widens the two shared "which upstream system" CHECK constraints
// (dashboard_metric_cache, dashboard_sync_log) to allow 'google' — ADDED
// 2026-07-30, per Jason directly, for the new Google Reviews tile. Every
// other source_system constraint in this schema only lists
// buildium/rent_engine/lead_simple; this is the first feature that needs a
// 4th value, so both places that enumerate the list need the same addition
// or the sync job/cache write would fail its own DB constraint the moment
// it tried to record a 'google' row.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("dashboard_metric_cache", "ck_dashboard_metric_cache_source_system");
  pgm.addConstraint("dashboard_metric_cache", "ck_dashboard_metric_cache_source_system", {
    check: "source_system IN ('buildium','rent_engine','lead_simple','google')",
  });

  pgm.dropConstraint("dashboard_sync_log", "ck_dashboard_sync_log_source_system");
  pgm.addConstraint("dashboard_sync_log", "ck_dashboard_sync_log_source_system", {
    check: "source_system IN ('buildium','rent_engine','lead_simple','google')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("dashboard_sync_log", "ck_dashboard_sync_log_source_system");
  pgm.addConstraint("dashboard_sync_log", "ck_dashboard_sync_log_source_system", {
    check: "source_system IN ('buildium','rent_engine','lead_simple')",
  });

  pgm.dropConstraint("dashboard_metric_cache", "ck_dashboard_metric_cache_source_system");
  pgm.addConstraint("dashboard_metric_cache", "ck_dashboard_metric_cache_source_system", {
    check: "source_system IN ('buildium','rent_engine','lead_simple')",
  });
}
