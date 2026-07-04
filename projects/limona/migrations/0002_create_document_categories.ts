import type { MigrationBuilder } from "node-pg-migrate";

// Fixed set of 7 categories per the approved spec — not an open-ended,
// admin-editable list. smallint id 1-7 so documents.category_id is a small,
// stable reference. Seeded here, not via the app, so the set can never drift
// out of sync between environments.
export async function up(pgm: MigrationBuilder): Promise<void> {
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
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("document_categories", "trg_set_updated_at_document_categories");
  pgm.dropTable("document_categories");
}
