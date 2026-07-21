import type { MigrationBuilder } from "node-pg-migrate";

const table = { schema: "map", name: "property_photos" };
const properties = { schema: "map", name: "properties" };

// References a copy stored in Supabase Storage, never a hot-linked
// Buildium URL (spec Section 4 / Risk #1). Photo-per-property (not
// photo-per-unit) for v1, per schema.md.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(table, {
    id: "id",
    property_id: { type: "bigint", notNull: true, references: properties, onDelete: "RESTRICT" },
    buildium_file_id: { type: "text", notNull: true },
    storage_bucket: { type: "text", notNull: true, default: "property-photos" },
    storage_path: { type: "text", notNull: true },
    content_type: { type: "text" },
    is_primary: { type: "boolean", notNull: true, default: false },
    synced_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(table, "uq_property_photos_property_id_buildium_file_id", {
    unique: ["property_id", "buildium_file_id"],
  });

  // At most one is_primary = true row per property — "which photo is
  // primary" can't silently become ambiguous.
  pgm.createIndex(table, "property_id", {
    name: "uq_property_photos_one_primary_per_property",
    unique: true,
    where: "is_primary",
  });

  pgm.createTrigger(table, "trg_set_updated_at_property_photos", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(table);
}
