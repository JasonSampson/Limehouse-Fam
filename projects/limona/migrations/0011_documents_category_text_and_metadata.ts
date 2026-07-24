import type { MigrationBuilder } from "node-pg-migrate";

// Replaces the fixed 7-row document_categories lookup table with a free-form
// text column on documents — matching how assets.category already works
// (see migration 0006). The Document Library overhaul no longer wants an
// admin-editable-but-fixed category list; category is now just a label the
// uploader types, same as assets. This also adds description and
// document_created_at, both nullable so the 48 pre-existing documents don't
// need backfilled values for them (description becomes required at the
// upload API level going forward, not via a DB constraint — see
// src/routes/adminDocumentRoutes.ts).
//
// Does NOT touch documents.version/replaces_document_id or any part of the
// re-upload/supersede logic in src/rag/ingest.ts.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // 1. Add the new text column, nullable for now so the backfill below can
  // populate it before we lock it down with NOT NULL.
  pgm.addColumn("documents", {
    category: { type: "text" },
  });

  // 2. Backfill from the existing lookup table. Every row today has a
  // non-null category_id (NOT NULL FK), so every row gets a real value here.
  pgm.sql(`
    UPDATE documents d
    SET category = c.name
    FROM document_categories c
    WHERE c.id = d.category_id;
  `);

  // 3. Now safe to enforce NOT NULL.
  pgm.alterColumn("documents", "category", { notNull: true });

  // 4. Drop the old lookup-table pointer. Dropping the column also drops its
  // FK constraint and the category_id index (both live solely on this
  // column), since Postgres removes dependent objects along with it.
  pgm.dropColumn("documents", "category_id");

  // 5. The lookup table itself is no longer referenced anywhere (confirmed
  // via grep before writing this migration — only adminDocumentRoutes.ts,
  // ingest.ts, and the frontend read/wrote category_id/document_categories,
  // and all three are updated in this same change). Dropping the table also
  // drops its own trigger and CHECK constraint.
  pgm.dropTable("document_categories");

  // 6. Mirror the plain btree index pattern already used for assets.category
  // (migration 0006) — the admin document list and future filtering both
  // want an index on this column.
  pgm.createIndex("documents", "category");

  // 7. Free-text description, nullable at the DB level (required by the
  // upload API going forward, but the 48 pre-existing documents have none).
  pgm.addColumn("documents", {
    description: { type: "text" },
  });

  // 8. Optional user-supplied "this document is dated ___" field, wholly
  // separate from version/replaces_document_id and the supersede-on-reupload
  // logic in src/rag/ingest.ts — those are untouched.
  pgm.addColumn("documents", {
    document_created_at: { type: "date" },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Reverse in the opposite order, recreating document_categories before
  // anything tries to reference it again.
  pgm.dropColumn("documents", "document_created_at");
  pgm.dropColumn("documents", "description");
  pgm.dropIndex("documents", "category");

  pgm.createTable("document_categories", {
    id: { type: "smallint", primaryKey: true },
    name: { type: "text", notNull: true, unique: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("document_categories", "ck_document_categories_id_range", {
    check: "id BETWEEN 1 AND 7",
  });

  pgm.createTrigger("document_categories", "trg_set_updated_at_document_categories", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });

  pgm.sql(`
    INSERT INTO document_categories (id, name) VALUES
      (1, 'Company Info'),
      (2, 'Job Descriptions'),
      (3, 'Laws'),
      (4, 'Leasing Docs'),
      (5, 'New Business'),
      (6, 'SOP'),
      (7, 'Vendors');
  `);

  // Add category_id back nullable first so we can map the text value back to
  // an id by name before enforcing NOT NULL.
  pgm.addColumn("documents", {
    category_id: { type: "smallint", references: "document_categories" },
  });

  pgm.sql(`
    UPDATE documents d
    SET category_id = c.id
    FROM document_categories c
    WHERE c.name = d.category;
  `);

  pgm.alterColumn("documents", "category_id", { notNull: true });
  pgm.createIndex("documents", "category_id");

  pgm.dropColumn("documents", "category");
}
