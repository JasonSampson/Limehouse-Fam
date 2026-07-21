import type { MigrationBuilder } from "node-pg-migrate";

// Two runtime roles, matching the role-separation pattern late-rent-notices
// already uses (its migration 0017), adapted for Map's schema-isolated
// shape in the shared Supabase project:
//
//   map_sync_job  — the daily background sync job. The only role with
//                   INSERT/UPDATE on every internal table plus
//                   map_public.locations and map.sync_runs. Never
//                   reachable from a browser.
//   map_staff_app — the internal staff app's backend (Tron's build, next).
//                   SELECT on every internal table, INSERT/UPDATE scoped to
//                   map.property_exclusions only (flagging/unflagging a
//                   property is the one write action a staff member takes
//                   directly). *Which* individual is allowed to write is
//                   enforced at the application layer — Map's backend sits
//                   behind LimeHQ's requireSession and calls
//                   hasPermission(userId, 'map.exclusions.manage') before
//                   any write, matching Limona's existing integration
//                   (schema.md) — not a Postgres-level distinction.
//
// Both roles get `search_path = map` so day-to-day queries don't need to
// hand-write the schema prefix, and an explicit `REVOKE ALL ON SCHEMA
// public` so neither can see Late Rent Notices'/Dashboard's/Limona's
// tables even by accident. Map has no per-PM row-scoping concept (every
// staff member sees the same data), so — same as late_rent_job's role —
// both roles get BYPASSRLS to function; 0011's FORCE ROW LEVEL SECURITY +
// zero policies exists specifically to block a future *stray* grant to
// `anon`/`authenticated`/any other low-privilege role, not to restrict
// these two legitimate internal roles from each other.
//
// Actual role passwords are set by Scotty at deploy time — this migration
// creates the roles with placeholder passwords that must be rotated before
// any real credential is used.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'map_sync_job') THEN
        CREATE ROLE map_sync_job LOGIN PASSWORD 'CHANGE_ME_AT_DEPLOY';
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'map_staff_app') THEN
        CREATE ROLE map_staff_app LOGIN PASSWORD 'CHANGE_ME_AT_DEPLOY';
      END IF;
    END
    $$;
  `);

  pgm.sql(`ALTER ROLE map_sync_job SET search_path = map;`);
  pgm.sql(`ALTER ROLE map_staff_app SET search_path = map;`);
  pgm.sql(`ALTER ROLE map_sync_job BYPASSRLS;`);
  pgm.sql(`ALTER ROLE map_staff_app BYPASSRLS;`);

  // Two-way fence, direction 1: neither role can see anything outside
  // `map`/`map_public`, even accidentally. Explicit REVOKE, not just "we
  // never granted" — a future migration in this project could otherwise
  // add a stray grant without anyone noticing (schema.md).
  pgm.sql(`REVOKE ALL ON SCHEMA public FROM map_sync_job, map_staff_app;`);
  pgm.sql(`REVOKE ALL ON SCHEMA map FROM PUBLIC;`);
  pgm.sql(`REVOKE ALL ON SCHEMA map_public FROM PUBLIC;`);

  // Two-way fence, direction 2: the other apps' own roles get nothing on
  // Map's schemas either. Guarded with IF EXISTS so this migration doesn't
  // fail on a database where late-rent-notices' roles haven't been created
  // (e.g. a fresh test DB that only runs Map's own migrations).
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'late_rent_app') THEN
        REVOKE ALL ON SCHEMA map, map_public FROM late_rent_app;
      END IF;
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'late_rent_job') THEN
        REVOKE ALL ON SCHEMA map, map_public FROM late_rent_job;
      END IF;
    END
    $$;
  `);

  pgm.sql(`GRANT USAGE ON SCHEMA map TO map_sync_job, map_staff_app;`);
  pgm.sql(`GRANT USAGE ON SCHEMA map_public TO map_sync_job, map_staff_app;`);

  const internalTables = [
    "map.properties",
    "map.units",
    "map.leases",
    "map.lease_tenants",
    "map.property_photos",
    "map.vacant_unit_asking_rents",
    "map.property_exclusions",
  ];

  // map_sync_job: full read/write on every internal table plus the two
  // sync-owned tables. No DELETE anywhere — the sync is additive/
  // preserving throughout (deactivate, never delete; a public dot is never
  // removed), matching b71080e's proven pattern.
  pgm.sql(
    `GRANT SELECT, INSERT, UPDATE ON ${internalTables.join(", ")}, map_public.locations, map.sync_runs TO map_sync_job;`
  );
  pgm.sql(
    `REVOKE DELETE ON ${internalTables.join(", ")}, map_public.locations, map.sync_runs FROM map_sync_job;`
  );
  pgm.sql(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA map TO map_sync_job;`);
  pgm.sql(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA map_public TO map_sync_job;`);

  // map_staff_app: read everything internal; the one write action a staff
  // member takes directly (behind LimeHQ's permission check) is flagging/
  // unflagging property_exclusions.
  pgm.sql(`GRANT SELECT ON ${internalTables.join(", ")}, map.sync_runs, map_public.locations TO map_staff_app;`);
  pgm.sql(`GRANT INSERT, UPDATE ON map.property_exclusions TO map_staff_app;`);
  pgm.sql(`REVOKE DELETE ON ${internalTables.join(", ")} FROM map_staff_app;`);
  pgm.sql(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA map TO map_staff_app;`);

  pgm.sql(`REVOKE TRUNCATE ON ALL TABLES IN SCHEMA map, map_public FROM map_sync_job, map_staff_app;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'map_sync_job') THEN
        DROP OWNED BY map_sync_job;
        DROP ROLE map_sync_job;
      END IF;
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'map_staff_app') THEN
        DROP OWNED BY map_staff_app;
        DROP ROLE map_staff_app;
      END IF;
    END
    $$;
  `);
}
