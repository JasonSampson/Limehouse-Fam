-- 0002_create_limona_test_schema.down.sql
-- Reverses 0002_create_limona_test_schema.up.sql. Drops the entire
-- limona_test schema (and everything in it -- this is throwaway test data
-- by definition) and the dedicated role. Safe to run any time; nothing in
-- limona_test is ever meant to persist.

BEGIN;

DROP SCHEMA IF EXISTS limona_test CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'limona_test_app') THEN
    DROP ROLE limona_test_app;
  END IF;
END
$$;

COMMIT;
