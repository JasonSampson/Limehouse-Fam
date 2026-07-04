import type { MigrationBuilder } from "node-pg-migrate";

// A thin 5-15 minute cache for the live pass-through tiles on the Dashboard
// tab (things like current occupancy, total units, open maintenance
// requests) — NOT a data warehouse. One row per (metric_key, scope), holding
// only the latest computed value plus when it was fetched. There is no
// history here on purpose: kpi_snapshots (0002) is where anything that
// needs a trend over time lives. This table exists purely so the dashboard
// doesn't hammer Buildium/RentEngine on every page load — app code reads
// this table first and only calls out to the source API when
// fetched_at is older than the cache window (enforced in app code, not the
// DB — a hard TTL constraint here would fight against manual refresh/debug
// needs).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("dashboard_metric_cache", {
    id: "id",
    metric_key: { type: "text", notNull: true }, // e.g. 'total_units', 'occupancy_rate', 'open_maintenance_requests'
    // scope disambiguates the same metric_key computed at different
    // granularities (e.g. portfolio-wide vs a specific property) without
    // needing a separate table per grain. 'portfolio' is the default/only
    // scope most tiles need today.
    scope: { type: "text", notNull: true, default: "portfolio" },
    source_system: { type: "text", notNull: true }, // 'buildium' | 'rent_engine' | 'lead_simple'
    value: { type: "jsonb", notNull: true }, // scalar or small object, e.g. {"value": 234} or {"count": 31, "breakdown": {...}}
    fetched_at: { type: "timestamptz", notNull: true },
    // stale/error state: when a source call fails, app code should NOT
    // delete the cached row (that would make a working tile go blank on a
    // transient API hiccup) — it should leave the last-known value in place
    // and record the failure here so the UI can show "last updated X ago,
    // refresh failed" instead of silently serving possibly-ancient data as
    // if it were fresh.
    last_error: { type: "text" },
    last_error_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("dashboard_metric_cache", "ck_dashboard_metric_cache_source_system", {
    check: "source_system IN ('buildium','rent_engine','lead_simple')",
  });

  pgm.addConstraint("dashboard_metric_cache", "uq_dashboard_metric_cache_key_scope", {
    unique: ["metric_key", "scope"],
  });

  pgm.createIndex("dashboard_metric_cache", ["fetched_at"], {
    name: "idx_dashboard_metric_cache_fetched_at",
  });

  pgm.createTrigger("dashboard_metric_cache", "trg_set_updated_at_dashboard_metric_cache", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("dashboard_metric_cache", "trg_set_updated_at_dashboard_metric_cache");
  pgm.dropTable("dashboard_metric_cache");
}
