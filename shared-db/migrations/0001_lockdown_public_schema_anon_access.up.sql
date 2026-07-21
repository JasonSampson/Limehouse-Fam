-- 0001_lockdown_public_schema_anon_access.up.sql
--
-- NOT owned by any single app -- see shared-db/README.md for why this
-- lives here instead of in projects/late-rent-notices, projects/map, or a
-- sibling repo's migrations folder.
--
-- WHAT THIS CLOSES
-- Sentinel found a live vulnerability while reviewing Map's public-site
-- page before launch (projects/map/public-site/). That page is the first
-- thing in this whole ecosystem to ship a Supabase `anon` public API key
-- into a fully public, unauthenticated browser context (necessary for a
-- public map with no login). Testing with that exact key, Sentinel proved
-- direct PostgREST calls to public.users, public.properties, and
-- public.audit_log return real rows -- real staff login rows including
-- bcrypt password hashes (public.users, owned by LimeHQ), real property
-- addresses (public.properties, owned by Late Rent Notices), and real
-- audit log entries (public.audit_log, owned by Late Rent Notices).
-- public.lease_tenants, public.leases, and public.exclusions happened to
-- come back empty under the same key, but that's Late Rent Notices' own
-- per-PM RLS policy (migration 0016) filtering rows for a role with no
-- app.current_pm_id set -- not a real barrier at the grant level, since
-- those policies apply to PUBLIC (every role, anon included) rather than
-- being scoped to late_rent_app/late_rent_job specifically. The underlying
-- grant is exactly as open as the tables that did return data.
--
-- ROOT CAUSE
-- This shared Supabase project (ref qafzhvccodchweeebovd) has run
-- Supabase's default `public` schema setup since day one, which grants
-- `anon`/`authenticated` USAGE on the schema plus default SELECT/INSERT/
-- UPDATE/DELETE on every table created in it. Late Rent Notices, LimeHQ,
-- Dashboard, and Limona all built real tables in `public` without ever
-- touching that default, because none of them talk to Supabase's REST/
-- anon-key path -- they all connect with their own named Postgres role
-- over a direct connection string, so the exposure was dormant until
-- Map's public-site became the first caller to actually use the anon key
-- from a public browser context.
--
-- CONFIRMED SAFE FOR ALL FOUR APPS (checked 2026-07-21, each project's own
-- .env / connection strings):
--   - late-rent-notices: DATABASE_URL uses `late_rent_app`, DATABASE_URL_JOB
--     uses `late_rent_job`. Both are named Postgres roles authenticating
--     directly over the pooler -- never anon/authenticated.
--   - limehouse-dashboard, limehq, limona: DATABASE_URL uses the Supabase
--     `postgres` role directly over the pooler -- also never anon/
--     authenticated. (That these three use the unscoped `postgres`
--     superuser role at all is a separate, already-tracked issue --
--     project_limona_db_role_scoping -- deliberately not touched here.)
-- None of the four apps' actual functionality depends on the
-- anon/authenticated grants this migration removes.
--
-- THE FIX
-- Same pattern already proven out for Map's own schemas
-- (projects/map/migrations/0010_create_roles_and_grants.ts and
-- 0011_enable_rls_force_no_policies.ts): revoke anon/authenticated's
-- access outright, at both the schema level (the single highest-leverage
-- move -- PostgREST needs schema USAGE to resolve any table in it at all)
-- and the table/sequence/function level (defense in depth), then fix
-- ALTER DEFAULT PRIVILEGES so a table created after this migration by the
-- `postgres` role (the role every app's migration runner connects as)
-- doesn't silently reacquire the same default exposure the current tables
-- had.
--
-- This migration does NOT touch any existing table's own RLS policies --
-- not Late Rent Notices' per-PM scoping (leases/lease_tenants/exclusions/
-- late_cycles/notices/notice_recipients, migration 0016), not Limona's
-- existing RLS-deny-public tables (migration 0008). It only removes a
-- grant none of the real apps use, so no app-role access, and no existing
-- policy, changes behavior.
--
-- WHAT THIS DOES NOT DO (flagged, not fixed here -- separate follow-up)
-- public.properties, public.audit_log, public.users (LimeHQ), and the
-- Dashboard tables have no RLS of their own today -- they were relying
-- entirely on the anon/authenticated grant being absent, which is
-- exactly the assumption this vulnerability broke. This migration closes
-- the hole at the grant level (verified below), but each app should still
-- add its own ENABLE/FORCE ROW LEVEL SECURITY with zero anon/authenticated
-- policies on its remaining unprotected tables, the same belt-and-
-- suspenders Late Rent Notices already has on 6 of its 14 tables and
-- Limona already has on all 7 of its tables -- so a future stray GRANT
-- fails closed instead of reopening this exact hole. That's real work
-- each app's own owner should scope and test, not a blind bulk change
-- bolted on here.

BEGIN;

REVOKE ALL ON SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

-- Prevent recurrence for tables/sequences/functions created after this
-- migration by the `postgres` role (the role every app's migration
-- runner uses against this project).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

COMMIT;
