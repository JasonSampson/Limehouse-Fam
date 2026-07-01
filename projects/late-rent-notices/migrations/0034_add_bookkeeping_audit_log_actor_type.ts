import type { MigrationBuilder } from "node-pg-migrate";

// Adds 'bookkeeping' as a valid audit_log.actor_type, same technique as
// migration 0028 (drop/recreate the same-named CHECK constraint widened —
// Postgres has no ALTER CONSTRAINT for CHECK). The Bookkeeping Coordinator
// role is read-only and takes no actions that write to audit_log today
// (no send/decide authority, no contact_attempts insert), but this keeps
// actor_type honest if/when a future read-triggering event (e.g. an export)
// needs to be logged under this role rather than mislabeled as 'pm'.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("audit_log", "ck_audit_log_actor_type");
  pgm.addConstraint("audit_log", "ck_audit_log_actor_type", {
    check: "actor_type IN ('system','pm','fallback_decision_maker','admin_assistant','bookkeeping')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("audit_log", "ck_audit_log_actor_type");
  pgm.addConstraint("audit_log", "ck_audit_log_actor_type", {
    check: "actor_type IN ('system','pm','fallback_decision_maker','admin_assistant')",
  });
}
