import type { MigrationBuilder } from "node-pg-migrate";

// Groups chat_queries into per-user conversation threads so staff can come
// back later and re-read an old chat (Reporting's "Recent Questions" and
// "Most Common Questions" stay exactly as-is — this is purely additive for
// the chat page's own history view). A conversation's title is just its
// first question's text, same as the vendor tool.
//
// answer_text is new on chat_queries: previously the generated answer was
// sent straight to the browser and never saved anywhere, which worked fine
// for a single sitting but means there was nothing to show if a past
// conversation were ever reopened. Citations aren't stored separately —
// they're reconstructed at read time from top_chunk_ids (same approach
// already used by Reporting's Most Common Questions).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("chat_conversations", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "text", notNull: true },
    title: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("chat_conversations", "user_id");

  pgm.addColumn("chat_queries", {
    conversation_id: { type: "uuid", references: "chat_conversations" },
    answer_text: { type: "text" },
  });
  pgm.createIndex("chat_queries", "conversation_id");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex("chat_queries", "conversation_id");
  pgm.dropColumn("chat_queries", ["conversation_id", "answer_text"]);
  pgm.dropTable("chat_conversations");
}
