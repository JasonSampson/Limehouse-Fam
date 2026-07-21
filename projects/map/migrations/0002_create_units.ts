import type { MigrationBuilder } from "node-pg-migrate";

const table = { schema: "map", name: "units" };
const properties = { schema: "map", name: "properties" };

// Synced from Buildium's /v1/rentalunits (per property). Bed/bath/square
// footage live at the unit level, and a single property can have multiple
// units — this table doesn't exist in late-rent-notices (it only ever
// needed a lease's unit label, not the physical attributes).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(table, {
    id: "id",
    property_id: { type: "bigint", notNull: true, references: properties, onDelete: "RESTRICT" },
    buildium_unit_id: { type: "text", notNull: true },
    unit_label: { type: "text", notNull: true },
    // Nullable — exact Buildium field name for bedrooms/bathrooms/sqft
    // still needs confirming against the live OpenAPI spec (schema.md
    // "Buildium/RentEngine Field Gaps" #1); modeled here per Neo's design.
    bedrooms: { type: "smallint" },
    bathrooms: { type: "numeric(3,1)" },
    square_feet: { type: "integer" },
    synced_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(table, "uq_units_buildium_unit_id", {
    unique: ["buildium_unit_id"],
  });

  pgm.createIndex(table, "property_id", { name: "idx_units_property_id" });

  pgm.createTrigger(table, "trg_set_updated_at_units", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(table);
}
