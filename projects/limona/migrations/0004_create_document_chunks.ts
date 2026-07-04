import type { MigrationBuilder } from "node-pg-migrate";

// Embedding dimension is 384 to match the local "Xenova/all-MiniLM-L6-v2"
// model (see src/rag/embeddings.ts) — runs fully on-device via
// @xenova/transformers, no API key required. If the embedding model choice
// ever changes, this column's dimension must change with it in a new
// migration, and every existing row must be re-embedded — vectors from two
// different models are not comparable.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("document_chunks", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    document_id: {
      type: "uuid",
      notNull: true,
      references: "documents",
      onDelete: "CASCADE",
    },
    chunk_index: { type: "integer", notNull: true },
    // The chunk text itself — this is what gets shown back to staff as the
    // quoted source snippet alongside the citation.
    content: { type: "text", notNull: true },
    embedding: { type: "vector(384)", notNull: true },
    page_or_section_label: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("document_chunks", "document_id");

  // No index on `embedding` — deliberately. An approximate-nearest-neighbor
  // index (e.g. ivfflat/hnsw) exists to make similarity search fast over
  // millions of vectors, at the cost of sometimes missing the true nearest
  // rows. This corpus is a 7-person internal team's knowledge base — tens to
  // low hundreds of documents, a few hundred to low thousands of chunks for
  // the foreseeable future. An exact sequential scan (`ORDER BY embedding
  // <=> $1`) over that many rows is fast (single-digit milliseconds) and,
  // unlike ivfflat, always finds the true nearest chunks. We tried ivfflat
  // with lists=100 first: at ~376 chunks that's ~3-4 vectors per partition,
  // and Postgres's default ivfflat.probes=1 searches only one partition —
  // it silently returned zero or wrong candidates for real staff questions
  // even when a clearly-relevant chunk existed. If this corpus ever grows
  // into the tens of thousands of chunks and sequential scan becomes
  // measurably slow, revisit with a properly-tuned ivfflat/hnsw index and
  // benchmark recall before adding it back — don't just flip it on.
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("document_chunks");
}
