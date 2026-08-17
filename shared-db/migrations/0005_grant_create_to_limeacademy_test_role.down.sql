-- 0005_grant_create_to_limeacademy_test_role.down.sql
--
-- Reverses 0005. The only consequence is that
-- projects/limeacademy/test/db/migrationSql.test.ts can no longer create its
-- throwaway schema, and will fail with the message it carries for exactly this
-- case -- naming the GRANT to run rather than surfacing an opaque permission
-- error.
--
-- Nothing else depends on this privilege. No object is dropped, because the
-- test's schema never survives its own transaction.

BEGIN;

REVOKE CREATE ON DATABASE postgres FROM limeacademy_test_app;

COMMIT;
