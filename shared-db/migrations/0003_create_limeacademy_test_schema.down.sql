-- 0003_create_limeacademy_test_schema.down.sql
-- Reverses 0003_create_limeacademy_test_schema.up.sql. Drops the entire
-- limeacademy_test schema (and everything in it -- this is throwaway test data
-- by definition, seeded with synthetic identities only, never a copy of real
-- staff records) and the dedicated role. Safe to run any time; nothing in
-- limeacademy_test is ever meant to persist.

BEGIN;

DROP SCHEMA IF EXISTS limeacademy_test CASCADE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'limeacademy_test_app') THEN
    DROP ROLE limeacademy_test_app;
  END IF;
END
$$;

COMMIT;
