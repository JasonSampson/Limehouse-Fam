import type { MigrationBuilder } from "node-pg-migrate";

// New role for Belinda and Vien: portfolio-wide admin support staff who log
// tenant contact attempts and need read visibility across ALL properties
// (not door-restricted like a Portfolio Manager, per Jason's confirmed
// decision). Default 'pm' preserves every existing user's current behavior;
// this column does not change what a plain 'pm' can do.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("pm_users", {
    role: { type: "text", notNull: true, default: "pm" },
  });

  pgm.addConstraint("pm_users", "ck_pm_users_role", {
    check: "role IN ('pm','admin_assistant')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("pm_users", "ck_pm_users_role");
  pgm.dropColumn("pm_users", "role");
}
