import type { MigrationBuilder } from "node-pg-migrate";

const view = { schema: "map_public", name: "locations_public" };

// The public map's ONLY path into the database. `anon` (Supabase's
// built-in public role, used by the public, unauthenticated
// limehousepm.com page) gets:
//   1. No USAGE grant on schema `map` at all — the schema itself is
//      invisible to `anon`, not just its tables (0010).
//   2. An explicit REVOKE ALL on every internal table and on
//      map_public.locations itself.
//   3. USAGE on schema `map_public` plus GRANT SELECT on a narrow view,
//      map_public.locations_public, exposing only city, latitude,
//      longitude, neighborhood_label — not id, not source_property_id,
//      not first_appeared_at/last_confirmed_at (sync-job bookkeeping, not
//      public map data).
//
// This is what makes Risk #3 a database-enforced guarantee instead of a
// frontend convention: a developer who reuses the internal pin/popup
// component for the public map, and forgets to strip tenant fields, can't
// actually leak them — the public map's Supabase connection is only ever
// capable of running a query that returns city/lat/lng/label, full stop,
// and it can't reach Late Rent Notices' tables either.
export async function up(pgm: MigrationBuilder): Promise<void> {
  const internalTables = [
    "map.properties",
    "map.units",
    "map.leases",
    "map.lease_tenants",
    "map.property_photos",
    "map.vacant_unit_asking_rents",
    "map.property_exclusions",
    "map.sync_runs",
  ];

  pgm.sql(`REVOKE ALL ON SCHEMA map FROM anon, authenticated;`);
  pgm.sql(`REVOKE ALL ON ${internalTables.join(", ")} FROM anon, authenticated, PUBLIC;`);
  pgm.sql(`REVOKE ALL ON map_public.locations FROM anon, authenticated, PUBLIC;`);

  pgm.createView(
    view,
    {},
    `SELECT city, latitude, longitude, neighborhood_label FROM map_public.locations`
  );

  pgm.sql(`GRANT USAGE ON SCHEMA map_public TO anon;`);
  pgm.sql(`GRANT SELECT ON map_public.locations_public TO anon;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropView(view);
}
