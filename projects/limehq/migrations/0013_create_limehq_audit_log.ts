import type { MigrationBuilder } from "node-pg-migrate";

// Minimal audit trail. Nothing in this codebase wrote to an audit log
// before this migration (checked staffRoutes.ts's existing edit/reset-
// password/deactivate routes — none of them log anywhere beyond the
// updated_at timestamp already on `users`), so this introduces the
// convention rather than matching a pre-existing one. Kept intentionally
// small: one row per notable action, a free-form jsonb `detail` bag instead
// of a wide fixed schema, so future actions can log without another
// migration. First consumer is the staff-delete action in staffRoutes.ts.
//
// Named limehq_audit_log, not audit_log: this Postgres database is shared
// across all five apps in this ecosystem (same public schema), and Late
// Rent Notices already owns a real, legally significant, tamper-evident
// audit_log table (hash-chained compliance records for tenant notices,
// 55+ real rows as of this migration). A generic "audit_log" name here
// would have collided with it outright — caught before this migration
// was ever run, not after.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("limehq_audit_log", {
    id: "id",
    // Who performed the action. RESTRICT (the default for a plain FK here)
    // is correct: users are never hard-deleted (see migration 0012), so this
    // FK can never be orphaned by normal application behavior.
    actor_user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
    },
    // Short machine-readable verb, e.g. "staff.delete".
    action: { type: "text", notNull: true },
    // What the action was performed on, e.g. "user".
    target_type: { type: "text", notNull: true },
    target_id: { type: "bigint", notNull: true },
    // Free-form extra context (e.g. { email, display_name } captured at the
    // time of the action, useful if the target row's own fields change later).
    detail: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("limehq_audit_log", ["target_type", "target_id"], {
    name: "idx_limehq_audit_log_target",
  });
  pgm.createIndex("limehq_audit_log", "actor_user_id", { name: "idx_limehq_audit_log_actor" });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("limehq_audit_log");
}
