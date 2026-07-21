import type { MigrationBuilder } from "node-pg-migrate";

const table = { schema: "map", name: "vacant_unit_asking_rents" };
const units = { schema: "map", name: "units" };

// From RentEngine. Per Oracle's spec and Neo's schema.md, this is a
// best-guess shape, NOT confirmed against a real RentEngine schema —
// RentEngine's API access/endpoint docs have not been handed over to this
// project yet (see src/rentengine/sync.ts, which stubs the sync itself).
// unit_id is nullable until the matching key between a RentEngine listing
// and a Buildium unit is confirmed.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(table, {
    id: "id",
    unit_id: { type: "bigint", references: units, onDelete: "RESTRICT" },
    rentengine_listing_id: { type: "text", notNull: true },
    asking_rent: { type: "numeric(10,2)", notNull: true },
    listed_at: { type: "timestamptz" },
    synced_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(table, "uq_vuar_rentengine_listing_id", {
    unique: ["rentengine_listing_id"],
  });

  pgm.createIndex(table, "unit_id", { name: "idx_vuar_unit_id" });

  pgm.createTrigger(table, "trg_set_updated_at_vuar", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(table);
}
