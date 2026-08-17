-- 0003_create_limeacademy_test_schema.up.sql
--
-- NOT owned by any single app -- see shared-db/README.md for why this lives
-- here instead of in projects/limeacademy's own migrations folder.
--
-- WHAT THIS IS
-- The disposable test database for LimeAcademy (staff training platform).
-- It follows 0002_create_limona_test_schema exactly, and deliberately so:
-- that migration established the reusable pattern -- a `<project>_test` schema
-- plus a `<project>_test_app` login role scoped to it -- precisely so that any
-- later project could adopt it without reopening the decision. This is the
-- first project to take it up.
--
-- Docker is not an option here and the reason is on the record: a prior
-- project's entire DB/RLS test suite is dead because it depended on a local
-- Docker Postgres container. Test databases in this ecosystem go through the
-- one shared Supabase project (ref qafzhvccodchweeebovd), which is already
-- paid for, already runs everything else, and is already locked down by
-- migration 0001 in this folder.
--
-- WHY THIS IS SAFE
-- `limeacademy_test_app` has no grants anywhere outside `limeacademy_test`,
-- with one narrow exception: USAGE (not SELECT/INSERT/etc, and not on any
-- table) on `public`, so that names in that schema can be RESOLVED. Schema
-- USAGE grants zero access to any table's data -- reading or writing a row
-- requires separate per-table grants this role was never given. So a bug in
-- LimeAcademy's test suite cannot touch a single row of live LimeHQ, Limona,
-- Late Rent Notices, Dashboard, or Map data.
--
-- ONE DIFFERENCE FROM 0002, AND IT IS DELIBERATE
-- Limona needed USAGE on public in order to resolve the `vector` type, which
-- is installed there. LimeAcademy uses no extension types at all, so it needs
-- public for nothing -- but the USAGE grant is kept anyway, for parity with
-- the established pattern and because removing it buys no additional
-- isolation (it already grants no data access) while creating a difference
-- between the two schemas that a future reader would have to re-derive.
--
-- LimeAcademy's own migration 0000 creates a local `set_updated_at()` inside
-- `limeacademy_test` when it does not already exist in the schema being
-- migrated, so this role never needs EXECUTE on anything in `public`. That is
-- why the REVOKE on public functions below is safe here.
--
-- REQUIRED SAFETY RULE, ENFORCED IN CODE, NOT BY CONVENTION
-- LimeAcademy's test suite refuses to run unless DATABASE_URL contains the
-- string "test" (case-insensitive) -- see
-- projects/limeacademy/test/support/requireTestDatabaseUrl.ts and
-- projects/limeacademy/.env.test.example. The connection string below
-- satisfies that via the `limeacademy_test_app` role name, even though the
-- database name is Supabase's default "postgres". This guard exists because a
-- missing .env.test once let a test run fall through to the real production
-- DATABASE_URL and truncate real data (Limona, 2026-07-03).
--
-- MIGRATING THE TEST SCHEMA
-- LimeAcademy's .node-pg-migraterc.json pins "schema": "public" for the real
-- app. The test run must override it, or it will migrate into public:
--   node-pg-migrate up --schema limeacademy_test --migrations-schema limeacademy_test
-- with DATABASE_URL pointing at limeacademy_test_app.
--
-- PASSWORD NOTE
-- The role is created below with a placeholder password. Before this migration
-- is considered fully applied, run:
--   ALTER ROLE limeacademy_test_app WITH PASSWORD '<a real generated password>';
-- and put that real password only in projects/limeacademy's own .env.test
-- (git-ignored), never in this committed file.

BEGIN;

CREATE SCHEMA IF NOT EXISTS limeacademy_test;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'limeacademy_test_app') THEN
    CREATE ROLE limeacademy_test_app WITH LOGIN PASSWORD 'CHANGE_ME_SEE_MIGRATION_HEADER' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Scope limeacademy_test_app to ONLY the limeacademy_test schema, plus
-- USAGE-only on public -- see "WHY THIS IS SAFE" above for why this grants no
-- data access.
GRANT USAGE, CREATE ON SCHEMA limeacademy_test TO limeacademy_test_app;
GRANT USAGE ON SCHEMA public TO limeacademy_test_app;
ALTER ROLE limeacademy_test_app SET search_path = limeacademy_test, public;

-- No separate "default privileges" grant is needed: LimeAcademy's migration
-- runner connects AS limeacademy_test_app to apply its migrations against this
-- schema, so it owns -- and therefore already has full rights on -- every
-- table, sequence and function it creates. (Supabase's managed `postgres` role
-- cannot set default privileges on behalf of another role anyway; see the note
-- in 0002.)

-- Explicitly confirm no TABLE/SEQUENCE/FUNCTION access on public -- only the
-- schema-level USAGE granted above is intended. These are no-ops if the
-- default grants were never present, which is expected; they make the
-- isolation guarantee an explicit, checkable statement rather than an
-- assumption.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM limeacademy_test_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM limeacademy_test_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM limeacademy_test_app;

COMMIT;
