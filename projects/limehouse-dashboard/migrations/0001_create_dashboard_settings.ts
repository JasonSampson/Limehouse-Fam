import type { MigrationBuilder } from "node-pg-migrate";

// Replaces the earlier design's reuse of late-rent-notices' pm_users +
// config_values tables. This project is a standalone database now, and the
// Team Performance tab is gated by ONE shared password — not per-person
// logins — so there is no reason to stand up a users table here at all.
// Per Jason's decision: don't duplicate pm_users unless a real reason shows
// up that this project needs individual staff logins. It doesn't today.
//
// dashboard_settings is a single-row settings table (not a generic
// key/value store, not versioned, no FK to any "who changed it" table). If
// this project later needs per-user auth or a real audit trail on config
// changes, that's a new migration when the actual need shows up — not
// speculative infrastructure today.
//
// id is forced to 1 via a check constraint so there can only ever be one
// row — the app always reads/updates id = 1, no "which row is active"
// logic required anywhere.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("dashboard_settings", {
    id: { type: "integer", primaryKey: true, default: 1 },
    // The shared password gate for the Team Performance tab. Stored as a
    // bcrypt/argon2 hash by the app — never plaintext. Nullable so this
    // migration can seed the row without a real password; the tab must stay
    // locked (no access) until Jason sets a real password, which is an
    // application-level check, not something this table enforces.
    team_performance_password_hash: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("dashboard_settings", "ck_dashboard_settings_singleton", {
    check: "id = 1",
  });

  pgm.createTrigger("dashboard_settings", "trg_set_updated_at_dashboard_settings", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });

  // Seed the single row. team_performance_password_hash stays NULL until
  // Jason sets the real shared password (app-level flow, not this
  // migration) — the tab is treated as locked/inaccessible while NULL.
  pgm.sql(`INSERT INTO dashboard_settings (id) VALUES (1);`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("dashboard_settings", "trg_set_updated_at_dashboard_settings");
  pgm.dropTable("dashboard_settings");
}
