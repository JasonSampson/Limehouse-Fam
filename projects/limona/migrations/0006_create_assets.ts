import type { MigrationBuilder } from "node-pg-migrate";

// Assets are a separate, simpler library from `documents` — brand/reference
// files (logos, templates, calculators, etc.) that admins upload for staff
// to find and download, but that are NEVER chunked/embedded/searched by the
// chatbot. So no status/version/supersede columns here: an asset just sits
// on disk until an admin deletes it. Original bytes live on disk only (same
// convention as documents), storage_path is relative
// ("assets/<id>/original/<filename>") so nothing bakes an absolute,
// machine-specific path into the database.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("assets", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    filename: { type: "text", notNull: true },
    description: { type: "text", notNull: true },
    // Free-form text rather than a fixed lookup table (unlike
    // document_categories) — keeps this feature simple, and the reference
    // tool's category list is just a suggestion, not a hard constraint.
    category: { type: "text", notNull: true },
    size_bytes: { type: "bigint", notNull: true },
    storage_path: { type: "text", notNull: true },
    uploaded_by: { type: "uuid", references: "users" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("assets", "category");

  pgm.createTrigger("assets", "trg_set_updated_at_assets", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("assets", "trg_set_updated_at_assets");
  pgm.dropTable("assets");
}
