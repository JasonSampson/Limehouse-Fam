import type { MigrationBuilder } from "node-pg-migrate";

const table = { schema: "map_public", name: "locations" };
const properties = { schema: "map", name: "properties" };

// The entire technical answer to spec Risk #3. Lives in its own schema
// (map_public, not map) with its own narrow column set, populated by an
// explicit sync step — not a view over map.properties with columns hidden
// by the frontend. Cannot contain a name, phone number, rent, exact
// address, or photo, because those columns do not exist on it, and the
// schema it lives in has no other tables for a stray query to wander into.
//
// Deliberately no is_active column, no exclusion-flag reference, no FK
// back to units/leases/tenants (schema.md). A dot is created once and is
// NEVER deleted and NEVER removed based on properties.is_active going
// false or property_exclusions existing — this table doesn't even have a
// status to deactivate. The sync step that populates this table must never
// join against property_exclusions for any purpose.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(table, {
    id: "id",
    city: { type: "text", notNull: true },
    latitude: { type: "numeric(9,6)", notNull: true },
    longitude: { type: "numeric(9,6)", notNull: true },
    neighborhood_label: { type: "text" },
    // Internal bookkeeping only — lets the sync job upsert idempotently.
    // Never selected by the public-facing query (enforced at the
    // grant/view level in 0012, not just by convention).
    source_property_id: { type: "bigint", references: properties, onDelete: "RESTRICT" },
    first_appeared_at: { type: "timestamptz", notNull: true },
    // Observability only — never used to hide/remove a dot.
    last_confirmed_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(table, "ck_locations_city", {
    check: `city IN ('Virginia Beach','Norfolk','Chesapeake','Portsmouth','Suffolk')`,
  });

  // One dot per property, forever.
  pgm.addConstraint(table, "uq_locations_source_property_id", {
    unique: ["source_property_id"],
  });

  pgm.createTrigger(table, "trg_set_updated_at_locations", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(table);
}
