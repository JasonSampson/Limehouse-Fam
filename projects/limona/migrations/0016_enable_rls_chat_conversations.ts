import type { MigrationBuilder } from "node-pg-migrate";

// chat_conversations (added in migration 0014, after the RLS sweep in
// migration 0008) was missed — this closes that gap the same way, for the
// same reason: defense in depth against a hypothetical future mistake where
// some code path uses the Supabase anon key directly instead of the
// table-owner DATABASE_URL connection this app always uses today. See
// migration 0008's comment for the full reasoning; nothing here changes how
// the app itself behaves, since table owners always bypass RLS.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE chat_conversations DISABLE ROW LEVEL SECURITY;`);
}
