import type { MigrationBuilder } from "node-pg-migrate";

// Team Knowledge: manually-typed quick-answer entries (a staff question
// paired with the exact answer an admin wants given for it), used alongside
// document_chunks in retrieval — see src/rag/retrieve.ts. Kept as its own
// table (rather than folding into document_chunks with a nullable
// document_id) so existing document retrieval/citation code paths are
// completely undisturbed: nothing about how document_chunks is queried,
// inserted, or joined changes. embedding is the same vector(384) shape as
// document_chunks.embedding (same local embedding model, see
// src/rag/embeddings.ts) so distance comparisons between the two are
// meaningful.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("team_knowledge", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    question: { type: "text", notNull: true },
    answer: { type: "text", notNull: true },
    embedding: { type: "vector(384)", notNull: true },
    created_by: { type: "uuid", references: "users" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // No ivfflat/hnsw index — same reasoning as document_chunks (migration
  // 0004): this table will hold at most a few hundred hand-typed entries for
  // a 7-person team, so an exact sequential scan is fast and always correct.

  pgm.createTrigger("team_knowledge", "trg_set_updated_at_team_knowledge", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("team_knowledge", "trg_set_updated_at_team_knowledge");
  pgm.dropTable("team_knowledge");
}
