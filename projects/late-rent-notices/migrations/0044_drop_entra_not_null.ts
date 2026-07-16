import type { MigrationBuilder } from "node-pg-migrate";

// Entra (Azure AD) auth has been replaced by LimeHQ handoff tokens.
// entra_object_id is no longer populated on login, so the NOT NULL
// constraint and unique index must go. The column is kept (nullable)
// so existing rows are not destroyed and can be cleaned up later.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("pm_users", "uq_pm_users_entra_object_id");
  pgm.alterColumn("pm_users", "entra_object_id", { notNull: false });
  pgm.alterColumn("pm_users", "display_name", { notNull: false });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn("pm_users", "display_name", { notNull: true });
  pgm.alterColumn("pm_users", "entra_object_id", { notNull: true });
  pgm.addConstraint("pm_users", "uq_pm_users_entra_object_id", {
    unique: ["entra_object_id"],
  });
}
