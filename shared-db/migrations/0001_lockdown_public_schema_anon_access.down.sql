-- 0001_lockdown_public_schema_anon_access.down.sql
--
-- Rollback for 0001_lockdown_public_schema_anon_access.up.sql. Restores
-- Supabase's original default grants on the `public` schema for
-- anon/authenticated.
--
-- Only run this if the lockdown is confirmed to have broken something.
-- Re-running this reopens the exact vulnerability Sentinel found (real
-- staff password hashes, property addresses, and audit log entries
-- readable by anyone holding the public anon key) -- do not run it to
-- "clean up" or as a routine reversal without a specific, confirmed
-- breakage to justify it.

BEGIN;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;

COMMIT;
