import type { MigrationBuilder } from "node-pg-migrate";

// Migration 0009 converted chat_queries.user_id from uuid to text so it
// could hold LimeHQ's integer user IDs, but missed three other columns that
// referenced the old (now-dropped) users table the same way:
//   - documents.uploaded_by
//   - assets.uploaded_by
//   - team_knowledge.created_by
//
// Their FK constraints were already dropped automatically when migration
// 0009 dropped the users table with CASCADE, but the column TYPE stayed
// uuid — so inserting a LimeHQ id like "1" fails with
// "invalid input syntax for type uuid". This fixes that the same way
// chat_queries.user_id was already fixed.
//
// None of these three columns are NOT NULL, unique, or indexed, so this is
// a straight type change with no other constraints to preserve.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn("documents", "uploaded_by", { type: "text", using: "uploaded_by::text" });
  pgm.alterColumn("assets", "uploaded_by", { type: "text", using: "uploaded_by::text" });
  pgm.alterColumn("team_knowledge", "created_by", { type: "text", using: "created_by::text" });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.alterColumn("documents", "uploaded_by", { type: "uuid", using: "uploaded_by::uuid" });
  pgm.alterColumn("assets", "uploaded_by", { type: "uuid", using: "uploaded_by::uuid" });
  pgm.alterColumn("team_knowledge", "created_by", { type: "uuid", using: "created_by::uuid" });
}
