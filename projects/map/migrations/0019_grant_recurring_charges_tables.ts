import type { MigrationBuilder } from "node-pg-migrate";

// 0010_create_roles_and_grants already ran against the live database, so
// the two new tables from 0017/0018 need their own grants here rather than
// editing an already-applied migration — same precedent as 0015.
//
// map_sync_job gets DELETE here too, a deliberate exception to 0010's
// blanket "no DELETE anywhere" comment for the original table set: a
// recurring charge that's genuinely gone from Buildium/RentEngine (removed,
// expired, reclassified as one-time/rent) needs to actually disappear, not
// sit stale forever — unlike `properties`, which is deactivate-never-delete.
// Neo's condition on approving this: since map_sync_job already has
// BYPASSRLS (0010), a table-level DELETE grant has no row-level narrowing
// available at the database layer — the actual safety has to live in the
// sync code itself. Confirmed both call sites are scoped exactly this way,
// never an unscoped DELETE FROM:
//   src/buildium/sync.ts:  DELETE FROM lease_recurring_charges
//                             WHERE lease_id = $1
//                               AND buildium_recurring_transaction_id != ALL($2::text[])
//   src/rentengine/sync.ts: DELETE FROM vacant_listing_recurring_charges
//                             WHERE vacant_unit_asking_rent_id = $1
//                               AND label != ALL($2::text[])
// Both only ever run after that specific lease's/listing's own fetch has
// already succeeded this run (a failed fetch is caught and skipped,
// leaving existing rows untouched) — same pattern as the rest of sync.ts.
//
// map_staff_app: SELECT only on both — these are sync-populated tables the
// staff app displays but never writes.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON map.lease_recurring_charges TO map_sync_job;
    GRANT SELECT, INSERT, UPDATE, DELETE ON map.vacant_listing_recurring_charges TO map_sync_job;
    GRANT USAGE ON map.lease_recurring_charges_id_seq TO map_sync_job;
    GRANT USAGE ON map.vacant_listing_recurring_charges_id_seq TO map_sync_job;

    GRANT SELECT ON map.lease_recurring_charges TO map_staff_app;
    GRANT SELECT ON map.vacant_listing_recurring_charges TO map_staff_app;
  `);

  // Explicit REVOKE TRUNCATE for both roles on both tables — TRUNCATE was
  // never granted above, so this isn't closing a real gap; it matches
  // 0010's closing pattern of making "no TRUNCATE" an explicit, documented
  // statement rather than an implicit default, for every table in map's
  // schema, including these two.
  pgm.sql(`
    REVOKE TRUNCATE ON map.lease_recurring_charges, map.vacant_listing_recurring_charges
      FROM map_sync_job, map_staff_app;
  `);

  // Both tables were created after 0011 enabled FORCE RLS with zero
  // policies on the tables that existed at that time — same defense-in-
  // depth 0015 applied to its own post-0011 tables, so a future stray
  // grant to anon/authenticated still can't read them by default.
  pgm.sql(`
    ALTER TABLE map.lease_recurring_charges ENABLE ROW LEVEL SECURITY;
    ALTER TABLE map.lease_recurring_charges FORCE ROW LEVEL SECURITY;
    ALTER TABLE map.vacant_listing_recurring_charges ENABLE ROW LEVEL SECURITY;
    ALTER TABLE map.vacant_listing_recurring_charges FORCE ROW LEVEL SECURITY;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    REVOKE ALL ON map.lease_recurring_charges FROM map_sync_job, map_staff_app;
    REVOKE ALL ON map.vacant_listing_recurring_charges FROM map_sync_job, map_staff_app;
  `);
}
