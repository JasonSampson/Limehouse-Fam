-- 0005_grant_create_to_limeacademy_test_role.up.sql
--
-- NOT owned by any single app -- see shared-db/README.md.
--
-- WHAT THIS IS
-- One privilege, granted to LimeAcademy's test login role: the ability to
-- CREATE A SCHEMA in this database. Nothing else.
--
-- WHY
-- projects/limeacademy/test/db/migrationSql.test.ts asks Postgres for its
-- verdict on every migration BEFORE any of them is applied. It opens a
-- transaction, creates a throwaway schema, runs every migration's up() SQL into
-- it, and then ALWAYS rolls back -- including on the throwing path. Nothing it
-- creates survives.
--
-- The gap it closes is concrete rather than hypothetical. Migrations had been
-- verified for several passes by rendering their SQL through a stubbed builder
-- and checking the text was well-formed. On 2026-08-16 migration 0029 passed
-- that check and was rejected by the server with SQLSTATE 42803 -- a correlated
-- subquery referencing an ungrouped column. The SQL was well-formed and
-- semantically invalid, and only the server could say so. All seven pending
-- migrations rolled back together, which worked correctly, but the error was
-- found at apply time rather than before it.
--
-- WHY THIS IS NARROW
-- CREATE on a DATABASE is the privilege to create a NEW schema. It conveys no
-- access to any schema that already exists. limeacademy_test_app's grants are
-- unchanged: it still holds nothing on public beyond USAGE, which grants no
-- access to any table's data. Verified when 0003 was applied -- the role was
-- pointed at public.users and refused with 42501, and that refusal still holds
-- after this grant.
--
-- The alternative considered and not taken: pre-create one fixed verification
-- schema owned by the role, granting CREATE on that schema instead of on the
-- database. Narrower, but two concurrent runs would collide inside a single
-- shared schema, and the per-run name is what makes the check safe to run at
-- any time. Revisit if the database-level grant ever becomes uncomfortable.
--
-- AUTHORIZATION
-- Approved by the Owner/Broker on 2026-08-16, after the trade-off was put to
-- him explicitly: it widens the test role from "can create things inside its
-- own sandbox" to "can create a new sandbox", while conveying no access to any
-- existing data.

BEGIN;

GRANT CREATE ON DATABASE postgres TO limeacademy_test_app;

COMMIT;
