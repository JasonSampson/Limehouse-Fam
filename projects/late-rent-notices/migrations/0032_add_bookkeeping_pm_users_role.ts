import type { MigrationBuilder } from "node-pg-migrate";

// New role: Bookkeeping Coordinator. Per Oracle's spec: "read-only across
// the ledger/delinquency data, no send/decide authority." Unlike
// admin_assistant (migration 0026/0027), this role gets NO insert access
// anywhere, including contact_attempts — pure SELECT, portfolio-wide, same
// scope as admin_assistant (not door-restricted like a Portfolio Manager).
// Same technique as migration 0026: Postgres has no ALTER CONSTRAINT for
// CHECK, so the existing constraint is dropped and recreated widened.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("pm_users", "ck_pm_users_role");
  pgm.addConstraint("pm_users", "ck_pm_users_role", {
    check: "role IN ('pm','admin_assistant','bookkeeping')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("pm_users", "ck_pm_users_role");
  pgm.addConstraint("pm_users", "ck_pm_users_role", {
    check: "role IN ('pm','admin_assistant')",
  });
}
