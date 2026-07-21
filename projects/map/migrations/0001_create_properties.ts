import type { MigrationBuilder } from "node-pg-migrate";

const table = { schema: "map", name: "properties" };

// Synced from Buildium's /v1/rentals. One row per Buildium rental property.
// Lives in the `map` schema now (not `public`) — see 0000_create_schemas.ts.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(table, {
    id: "id",
    buildium_property_id: { type: "text", notNull: true },
    source: { type: "text", notNull: true, default: "buildium" },
    name: { type: "text" },
    address_line1: { type: "text", notNull: true },
    address_line2: { type: "text" },
    city: { type: "text", notNull: true },
    state: { type: "text", notNull: true },
    postal_code: { type: "text", notNull: true },
    // From Google Geocoding API, not Buildium.
    latitude: { type: "numeric(9,6)" },
    longitude: { type: "numeric(9,6)" },
    geocode_status: { type: "text", notNull: true, default: "pending" },
    geocoded_at: { type: "timestamptz" },
    // Mirrors Buildium's status=Active/IsActive, same semantics as
    // late-rent-notices.properties.is_active (b71080e) — a physically
    // separate table (different schema, same shared database), same
    // agreed-upon meaning. Never set false by a missing row disappearing
    // from a partial fetch; only by an explicit "no longer active" result.
    is_active: { type: "boolean", notNull: true, default: true },
    synced_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(table, "uq_properties_buildium_property_id", {
    unique: ["buildium_property_id"],
  });

  pgm.addConstraint(table, "ck_properties_geocode_status", {
    check: "geocode_status IN ('pending','ok','failed')",
  });

  pgm.createIndex(table, "is_active", { name: "idx_properties_is_active" });
  pgm.createIndex(table, ["city", "is_active"], { name: "idx_properties_city_is_active" });

  pgm.createTrigger(table, "trg_set_updated_at_properties", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(table);
}
