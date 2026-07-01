import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("properties", {
    id: "id",
    buildium_property_id: { type: "text", notNull: true },
    source: { type: "text", notNull: true, default: "buildium" },
    name: { type: "text", notNull: true },
    address_line1: { type: "text", notNull: true },
    address_line2: { type: "text" },
    city: { type: "text", notNull: true },
    state: { type: "text", notNull: true },
    postal_code: { type: "text", notNull: true },
    owner_buildium_id: { type: "text" },
    synced_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("properties", "uq_properties_buildium_property_id", {
    unique: ["buildium_property_id"],
  });

  pgm.createIndex("properties", "state", { name: "idx_properties_state" });

  pgm.createTrigger("properties", "trg_set_updated_at_properties", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("properties");
}
