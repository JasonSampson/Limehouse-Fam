import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("job_runs", {
    id: "id",
    job_name: { type: "text", notNull: true },
    scheduled_for: { type: "timestamptz", notNull: true },
    started_at: { type: "timestamptz" },
    completed_at: { type: "timestamptz" },
    status: { type: "text", notNull: true, default: "pending" },
    error_message: { type: "text" },
    leases_checked: { type: "integer" },
    notices_drafted: { type: "integer" },
    jason_alerted_at: { type: "timestamptz" },
    trace_id: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("job_runs", "ck_job_runs_status", {
    check: "status IN ('pending','running','succeeded','failed')",
  });

  pgm.createIndex("job_runs", ["job_name", "scheduled_for"], {
    name: "idx_job_runs_job_name_scheduled",
    method: "btree",
  });

  pgm.createTrigger("job_runs", "trg_set_updated_at_job_runs", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("job_runs");
}
