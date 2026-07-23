-- 0002_create_limona_test_schema.up.sql
--
-- NOT owned by any single app -- see shared-db/README.md for why this
-- lives here instead of in projects/limona's own migrations folder.
--
-- WHAT THIS IS
-- Limona's disposable test database used to be a throwaway Docker Postgres
-- container. Jason decided to stop using Docker (and any other extra local
-- software) for test databases across this ecosystem -- everything should
-- go through Supabase, which he already pays for and already runs
-- everything else on. A second, separate Supabase project for test data
-- was considered and rejected: after migration 0001 in this same folder
-- (closing a cross-app data-exposure hole in the one shared project), the
-- direction has been to centralize and tightly lock down the ONE shared
-- Supabase project, not multiply the number of projects there are to
-- secure and manage.
--
-- THE FIX
-- A dedicated schema (`limona_test`) inside the existing shared Supabase
-- project (ref qafzhvccodchweeebovd), with its own dedicated login role
-- (`limona_test_app`) that is granted permissions ONLY on that schema --
-- nothing on `public` (where the real, live Limona/LimeHQ/Late Rent
-- Notices/Dashboard tables live) and nothing on any other app's schema
-- (e.g. Map's `map`/`map_public`). This mirrors the same "dedicated schema
-- + dedicated role" isolation pattern Map already uses for its own
-- production tables (see projects/map/docs/schema.md) -- applied here to
-- test data instead of production data.
--
-- This is deliberately written as a reusable pattern, not hardcoded to
-- Limona only: any other project that wants the same Docker-free test
-- setup can follow this exact shape (its own `<project>_test` schema +
-- `<project>_test_app` role) as a follow-up migration in this same folder,
-- without needing to revisit this decision again.
--
-- WHY THIS IS SAFE
-- `limona_test_app` has no grants anywhere outside `limona_test`, with one
-- narrow exception: USAGE (not SELECT/INSERT/etc, and not on any table) on
-- `public`, because that's the schema this shared project's `vector`
-- extension type lives in (confirmed via pg_extension/pg_namespace), and
-- Limona's tables need that type. Schema USAGE only allows *resolving*
-- object names in that schema (like the `vector` type) -- it grants zero
-- access to any table's actual data, so this does not weaken the
-- isolation guarantee: a bug in Limona's test suite still cannot read or
-- write a single row of real data, because that requires separate,
-- per-table grants this role was never given.
--
-- PASSWORD NOTE
-- The role is created below with a placeholder password. Before this
-- migration is considered fully applied, run:
--   ALTER ROLE limona_test_app WITH PASSWORD '<a real generated password>';
-- and put that real password only in projects/limona's own .env.test
-- (git-ignored), never in this committed file.

BEGIN;

CREATE SCHEMA IF NOT EXISTS limona_test;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'limona_test_app') THEN
    CREATE ROLE limona_test_app WITH LOGIN PASSWORD 'CHANGE_ME_SEE_MIGRATION_HEADER' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Scope limona_test_app to ONLY the limona_test schema, plus USAGE-only on
-- public so the `vector` type (installed there, not in limona_test) can be
-- resolved -- see "WHY THIS IS SAFE" above for why this doesn't grant any
-- data access.
GRANT USAGE, CREATE ON SCHEMA limona_test TO limona_test_app;
GRANT USAGE ON SCHEMA public TO limona_test_app;
ALTER ROLE limona_test_app SET search_path = limona_test, public;

-- No separate "default privileges" grant is needed here: Limona's own
-- migration runner will connect AS limona_test_app to apply its migrations
-- against this schema, so it will own (and therefore already have full
-- rights on) every table/sequence it creates. (An earlier draft of this
-- migration tried to set default privileges for limona_test_app from the
-- connecting `postgres` role -- Supabase's managed `postgres` role doesn't
-- have permission to do that for another role, and it wasn't needed.)

-- Explicitly confirm no TABLE/SEQUENCE/FUNCTION access on public -- only
-- the schema-level USAGE granted above (for the vector type) is intended.
-- (These are no-ops if the default grants were never present, which is
-- expected -- this just makes the isolation guarantee an explicit,
-- checkable statement rather than an assumption.)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM limona_test_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM limona_test_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM limona_test_app;

COMMIT;
