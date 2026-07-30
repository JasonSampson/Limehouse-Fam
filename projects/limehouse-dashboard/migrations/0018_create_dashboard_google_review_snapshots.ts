import type { MigrationBuilder } from "node-pg-migrate";

// One row per calendar day, recording Limehouse's Google rating/review
// count as of that day — ADDED 2026-07-30, per Jason directly, for the new
// Google Reviews tile (Dashboard > Top of Mind). This is deliberately its
// own small table rather than reusing dashboard_metric_cache (that table is
// explicitly a short-TTL cache, not a history table — see its own migration
// comment) or dashboard_kpi_snapshots (that table is quarterly and tied to
// Team Performance's kpi_definition_id, not a fit for a daily portfolio-wide
// number). "New reviews this period" is computed in app code by comparing
// today's row to the nearest row on/before the period's start date — there
// is no way to backfill this table, so any period before the day this
// feature shipped will have no earlier row to compare against.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("dashboard_google_review_snapshots", {
    id: "id",
    snapshot_date: { type: "date", notNull: true },
    rating: { type: "numeric", notNull: true },
    review_count: { type: "integer", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // ON CONFLICT (snapshot_date) DO UPDATE in app code relies on this being
  // unique — the job can run more than once a day (manual "Sync Now" plus
  // the scheduled interval) and should just keep overwriting today's row,
  // not create duplicates.
  pgm.addConstraint("dashboard_google_review_snapshots", "uq_dashboard_google_review_snapshots_date", {
    unique: ["snapshot_date"],
  });

  pgm.createIndex("dashboard_google_review_snapshots", ["snapshot_date"], {
    name: "idx_dashboard_google_review_snapshots_date",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("dashboard_google_review_snapshots");
}
