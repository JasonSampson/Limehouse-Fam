import type { MigrationBuilder } from "node-pg-migrate";

// 0013_add_staff_safety_concern_reason_code.ts created two views
// (property_exclusions_effective, staff_safety_concern_geographic_
// distribution) but never granted map_staff_app SELECT on them — a real
// gap, not just theoretical: it 500-crashed the entire GET /map/api/
// properties endpoint in TARS's live end-to-end test, since
// fetchActiveMapProperties() queries property_exclusions_effective
// directly. TARS applied a temporary out-of-band `GRANT SELECT` on the live
// database to keep testing; this migration makes that grant durable and
// tracked, so it isn't silently lost on the next rebuild (a fresh database
// applying every migration from 0000 would otherwise recreate both views
// with no grant at all, reproducing the exact same crash).
//
// Same grant shape 0010_create_roles_and_grants.ts already uses for every
// other map_staff_app-readable table — SELECT only, no write access, since
// both of these are read-only computed views over property_exclusions
// (itself already staff-writable via 0010) and properties.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    GRANT SELECT ON map.property_exclusions_effective TO map_staff_app;
    GRANT SELECT ON map.staff_safety_concern_geographic_distribution TO map_staff_app;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    REVOKE SELECT ON map.property_exclusions_effective FROM map_staff_app;
    REVOKE SELECT ON map.staff_safety_concern_geographic_distribution FROM map_staff_app;
  `);
}
