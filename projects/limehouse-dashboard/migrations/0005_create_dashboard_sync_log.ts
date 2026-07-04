import type { MigrationBuilder } from "node-pg-migrate";

// Append-only log of every sync attempt against an upstream source
// (Buildium / RentEngine / LeadSimple), so the dashboard can show an HONEST
// "last synced" timestamp per source instead of a vague "just now" that
// doesn't reflect whether the last attempt actually succeeded. Modeled
// after late-rent-notices' job_runs table (0014_create_job_runs.ts) — same
// started_at/completed_at/status shape — but scoped to sync attempts against
// external dashboard data sources rather than the notice-sending job.
//
// App code determines "last synced" per source by querying the most recent
// row here WHERE status = 'succeeded' for that source — never just the most
// recent row regardless of outcome, so a run of failures doesn't make the
// UI falsely claim data is fresh.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("dashboard_sync_log", {
    id: "id",
    source_system: { type: "text", notNull: true }, // 'buildium' | 'rent_engine' | 'lead_simple'
    sync_type: { type: "text", notNull: true }, // e.g. 'metric_cache_refresh', 'kpi_snapshot_compute', 'gl_history_backfill'
    started_at: { type: "timestamptz", notNull: true },
    completed_at: { type: "timestamptz" },
    status: { type: "text", notNull: true, default: "running" },
    records_synced: { type: "integer" },
    error_message: { type: "text" },
    trace_id: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("dashboard_sync_log", "ck_dashboard_sync_log_source_system", {
    check: "source_system IN ('buildium','rent_engine','lead_simple')",
  });
  pgm.addConstraint("dashboard_sync_log", "ck_dashboard_sync_log_status", {
    check: "status IN ('running','succeeded','failed')",
  });

  pgm.createIndex("dashboard_sync_log", ["source_system", "status", "completed_at"], {
    name: "idx_dashboard_sync_log_source_status_completed",
  });

  pgm.createTrigger("dashboard_sync_log", "trg_set_updated_at_dashboard_sync_log", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("dashboard_sync_log", "trg_set_updated_at_dashboard_sync_log");
  pgm.dropTable("dashboard_sync_log");
}
