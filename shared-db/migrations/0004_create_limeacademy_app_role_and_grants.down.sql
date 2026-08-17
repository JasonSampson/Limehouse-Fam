-- 0004_create_limeacademy_app_role_and_grants.down.sql
--
-- Reverses 0004_create_limeacademy_app_role_and_grants.up.sql: removes every
-- privilege granted to `limeacademy_app` and drops the role.
--
-- ===========================================================================
-- READ THIS BEFORE RUNNING IT
-- ===========================================================================
-- This rollback DESTROYS NO DATA. It touches no row of any table, in any app.
-- All it removes is a role and its grants. That is worth stating plainly,
-- because it is the opposite of the usual reason to hesitate over a `down`
-- migration.
--
-- What it DOES do is take LimeAcademy offline if LimeAcademy is already
-- connecting as this role. Dropping the role a live application authenticates
-- with is a hard outage for that application -- and only that application;
-- nothing else in the shared project uses it.
--
-- SO THIS IS ALMOST CERTAINLY NOT THE ROLLBACK YOU WANT. If the scoped role is
-- causing a problem -- an unexpected "permission denied" on a route nobody
-- tested -- the correct move is to put the old `postgres` connection string
-- back in LimeAcademy's DATABASE_URL and restart. That restores service in
-- seconds, leaves this role in place for the next attempt, and needs no
-- database change at all. The up-migration's ROLLOUT notes say to keep that
-- string for one to two weeks precisely so this file is never the fast path.
--
-- Run this only when the scoped role is being abandoned or rebuilt from
-- scratch. Confirm nothing is connected first:
--
--     SELECT count(*) FROM pg_stat_activity WHERE usename = 'limeacademy_app';
--
-- If that is not zero, stop -- something is live on this role and DROP ROLE
-- will fail (or you will take it down). `REASSIGN OWNED` is not needed: the
-- role owns no objects by design, which is the whole point of it.
--
-- Applying this does NOT restore superuser access to LimeAcademy. It removes
-- the scoped alternative; the app's connection string is a separate,
-- deliberate change made outside this file.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'limeacademy_app') THEN
    -- DROP ROLE refuses while the role still holds a privilege anywhere in the
    -- database, and the up-migration grants a lot of them: table and view
    -- privileges on 43 tables and 4 views, USAGE on 42 sequences, EXECUTE on 31
    -- functions, and USAGE on the schema itself. DROP OWNED BY removes all of
    -- them in one statement rather than requiring this file to re-enumerate a
    -- list that would then have to be kept in step with the up-migration
    -- forever. The role owns no objects, so nothing is dropped by it.
    --
    -- The role-level `search_path` setting from the up-migration is stored
    -- against the role and goes with DROP ROLE; it needs no separate reset.
    DROP OWNED BY limeacademy_app;
    DROP ROLE limeacademy_app;
  END IF;
END
$$;

COMMIT;
