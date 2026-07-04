import type { MigrationBuilder } from "node-pg-migrate";

// documents.id IS the {document_id} directory name under
// storage/documents/ — the original uploaded file bytes live only on disk
// (never in this table), so "download original" is just reading that file
// back untouched. storage_path is relative (e.g.
// "documents/<id>/original/<filename>") so the app never bakes an absolute,
// machine-specific path into the database.
//
// Re-upload/replace creates a NEW row (new id, version = old + 1,
// replaces_document_id = old id) rather than overwriting — see the app-level
// transaction in src/rag/ingest.ts for how old/new status flips happen
// atomically so a failed re-chunk never breaks the previously-working
// document.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("documents", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    filename: { type: "text", notNull: true },
    category_id: { type: "smallint", notNull: true, references: "document_categories" },
    file_size_bytes: { type: "bigint", notNull: true },
    file_ext: { type: "text", notNull: true },
    storage_path: { type: "text", notNull: true },
    uploaded_by: { type: "uuid", references: "users" },
    status: { type: "text", notNull: true, default: "processing" },
    version: { type: "integer", notNull: true, default: 1 },
    replaces_document_id: { type: "uuid", references: "documents" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("documents", "ck_documents_status", {
    check: "status IN ('processing', 'ready', 'failed', 'superseded')",
  });

  pgm.createIndex("documents", "category_id");
  // Every retrieval query filters WHERE status = 'ready', so this is the hot
  // path index for both chat retrieval and the admin document list.
  pgm.createIndex("documents", "status");

  pgm.createTrigger("documents", "trg_set_updated_at_documents", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("documents", "trg_set_updated_at_documents");
  pgm.dropTable("documents");
}
