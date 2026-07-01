import type { MigrationBuilder } from "node-pg-migrate";

// Adds 'admin_assistant' as a valid audit_log.actor_type so contact-attempt
// logging by Belinda/Vien can be recorded honestly (not mislabeled as 'pm').
// Postgres has no ALTER CONSTRAINT for CHECK — the original (migration 0015)
// is left untouched, this drops and recreates the same-named constraint with
// the widened list, same technique as any other check-constraint widening.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("audit_log", "ck_audit_log_actor_type");
  pgm.addConstraint("audit_log", "ck_audit_log_actor_type", {
    check: "actor_type IN ('system','pm','fallback_decision_maker','admin_assistant')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("audit_log", "ck_audit_log_actor_type");
  pgm.addConstraint("audit_log", "ck_audit_log_actor_type", {
    check: "actor_type IN ('system','pm','fallback_decision_maker')",
  });
}
