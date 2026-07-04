import type { MigrationBuilder } from "node-pg-migrate";

// One row per staff question. `answered = false` is the durable record of
// "Limona said it didn't know" — nothing cleared the similarity threshold in
// src/rag/retrieve.ts. top_chunk_ids is null in that case; otherwise it
// records which chunks were used to ground the answer, so the citation
// shown to the user is auditable after the fact.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("chat_queries", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    user_id: { type: "uuid", notNull: true, references: "users" },
    question: { type: "text", notNull: true },
    answered: { type: "boolean", notNull: true },
    top_chunk_ids: { type: "uuid[]" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("chat_queries", "user_id");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("chat_queries");
}
