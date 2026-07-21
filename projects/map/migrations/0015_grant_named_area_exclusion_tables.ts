import type { MigrationBuilder } from "node-pg-migrate";

// 0010_create_roles_and_grants already ran against the live database, so
// the two new tables from 0014 need their own grants here rather than
// editing an already-applied migration.
//
// map_sync_job: reads areas (to know what to snapshot) and writes the
// shadow-match log — never writes to named_area_exclusions itself (that's
// a staff/admin action via map_staff_app, gated by LimeHQ's
// hasPermission() checks, not the sync job's role).
//
// map_staff_app: full read/write on named_area_exclusions (create, edit
// boundary, and the shadow->active/retired transition are all actions a
// staff member takes directly through the app — *which* individual is
// allowed to do *which* of those is enforced at the application layer via
// map.area_exclusions.manage vs. map.area_exclusions.activate, not by
// Postgres, same pattern as property_exclusions). Read-only on the
// shadow-match log (it's sync-job-populated, staff only review it).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    GRANT SELECT ON map.named_area_exclusions TO map_sync_job;
    GRANT SELECT, INSERT ON map.named_area_exclusion_shadow_matches TO map_sync_job;
    REVOKE DELETE, UPDATE ON map.named_area_exclusion_shadow_matches FROM map_sync_job;
    GRANT USAGE ON map.named_area_exclusions_id_seq TO map_sync_job;
    GRANT USAGE ON map.named_area_exclusion_shadow_matches_id_seq TO map_sync_job;

    GRANT SELECT, INSERT, UPDATE ON map.named_area_exclusions TO map_staff_app;
    REVOKE DELETE ON map.named_area_exclusions FROM map_staff_app;
    GRANT SELECT ON map.named_area_exclusion_shadow_matches TO map_staff_app;
    GRANT USAGE ON map.named_area_exclusions_id_seq TO map_staff_app;
  `);

  // These two tables were created after 0011 enabled FORCE RLS with zero
  // policies on the tables that existed at that time — apply the same
  // defense-in-depth here so a future stray grant to anon/authenticated
  // still can't read them by default.
  pgm.sql(`
    ALTER TABLE map.named_area_exclusions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE map.named_area_exclusions FORCE ROW LEVEL SECURITY;
    ALTER TABLE map.named_area_exclusion_shadow_matches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE map.named_area_exclusion_shadow_matches FORCE ROW LEVEL SECURITY;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    REVOKE ALL ON map.named_area_exclusions FROM map_sync_job, map_staff_app;
    REVOKE ALL ON map.named_area_exclusion_shadow_matches FROM map_sync_job, map_staff_app;
  `);
}
