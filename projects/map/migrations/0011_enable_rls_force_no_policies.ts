import type { MigrationBuilder } from "node-pg-migrate";

// Risk #3 (spec) database-level enforcement, per Neo's schema.md
// "Enforcing the Public/Internal Split at the Database Level": row-level
// security ENABLED and FORCED on every table in the `map` schema, with
// ZERO policies defined for anon/authenticated. This is defense-in-depth,
// not the primary defense (the primary defense is that `anon` gets no
// GRANT at all on these tables, and no USAGE on the `map` schema itself —
// see 0010 and 0012) — but it means even a future migration that
// accidentally adds a stray grant still can't leak a read, because FORCE
// ROW LEVEL SECURITY + no policy = default deny for any role that isn't
// BYPASSRLS. Only map_sync_job and map_staff_app are BYPASSRLS (0010) — a
// role like `anon` picking up a stray future grant would still see
// nothing.
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

export async function up(pgm: MigrationBuilder): Promise<void> {
  for (const table of internalTables) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
  }

  // map_public.locations deliberately does NOT get FORCE ROW LEVEL
  // SECURITY here — its protection is structural narrowness (the table has
  // no PII columns to begin with) plus the anon grant being scoped only to
  // the map_public.locations_public view created in 0012, never the base
  // table directly (anon gets zero grant on the base table). Forcing RLS
  // on this table would also restrict the view's own read path (views
  // execute with the view owner's privileges, and FORCE applies even to
  // the owner), which would break the public map with no benefit — there's
  // no PII on this table for RLS to be defending in the first place.
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  for (const table of internalTables) {
    pgm.sql(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
  }
}
