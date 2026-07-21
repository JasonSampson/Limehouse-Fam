import type { MigrationBuilder } from "node-pg-migrate";

const table = { schema: "map", name: "sync_runs" };

// Job observability — same shape and purpose as late-rent-notices'
// job_runs, feeding the same "silent failures become real alerts" pattern
// from commit bfc5a73 (spec Risk #2 — explicit requirement, not a
// nice-to-have). error_message must be populated on any partial failure,
// not just hard crashes — see src/jobs/mapJobRunner.ts.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(table, {
    id: "id",
    job_name: { type: "text", notNull: true },
    scheduled_for: { type: "timestamptz", notNull: true },
    started_at: { type: "timestamptz" },
    completed_at: { type: "timestamptz" },
    status: { type: "text", notNull: true, default: "pending" },
    error_message: { type: "text" },
    properties_synced: { type: "integer" },
    units_synced: { type: "integer" },
    leases_synced: { type: "integer" },
    photos_synced: { type: "integer" },
    public_locations_synced: { type: "integer" },
    jason_alerted_at: { type: "timestamptz" },
    trace_id: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(table, "ck_sync_runs_status", {
    check: "status IN ('pending','running','succeeded','failed')",
  });

  // job_name is one of: buildium_sync, rentengine_sync, geocode_sync,
  // photo_sync, public_map_derive (schema.md) — not DB-enforced as a CHECK
  // since new step names may be added; kept as free text like
  // late-rent-notices.job_runs.job_name.
  pgm.createIndex(table, ["job_name", "scheduled_for"], {
    name: "idx_sync_runs_job_name_scheduled",
  });

  pgm.createTrigger(table, "trg_set_updated_at_sync_runs", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(table);
}
