import type { MigrationBuilder } from "node-pg-migrate";

// Same shape of problem as team_knowledge.created_by_name (0012): Limona has
// no local users table, and chat_queries.user_id only resolves to a display
// name when it happens to match a real LimeHQ account (see
// adminReportingRoutes.ts's LEFT JOIN users). Some real askers (e.g. people
// listed on the old vendor tool who don't have a LimeHQ Staff & Permissions
// profile yet) have no matching account at all, so their name would
// otherwise be lost entirely instead of just falling back to an email.
// asked_by_name is a nullable, denormalized fallback for exactly that case.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("chat_queries", {
    asked_by_name: { type: "text" },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("chat_queries", "asked_by_name");
}
