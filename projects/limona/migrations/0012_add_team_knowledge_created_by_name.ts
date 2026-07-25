import type { MigrationBuilder } from "node-pg-migrate";

// Limona has no local users table (dropped in 0009 — identity now comes
// entirely from the LimeHQ session, see src/auth/middleware.ts), so
// team_knowledge.created_by (a LimeHQ user id) can't be joined against
// anything to show "who added this entry" later. Storing the display name
// directly at write time is the only way to show it back on the Team
// Knowledge page.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("team_knowledge", {
    created_by_name: { type: "text" },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("team_knowledge", "created_by_name");
}
