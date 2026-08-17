-- 0004_create_limeacademy_app_role_and_grants.up.sql
--
-- ===========================================================================
-- WHAT THIS IS
-- ===========================================================================
-- `limeacademy_app` -- the Postgres role the LimeAcademy web application
-- connects as in production, replacing the shared Supabase `postgres`
-- superuser role that Dashboard, LimeHQ, Limona and LimeAcademy have all been
-- using.
--
-- Sentinel returned BLOCKED on LimeAcademy with this as one of four S1
-- findings. The finding was that every app in this ecosystem connects as the
-- project superuser, so one flaw in any one of them reaches all five
-- applications' production data -- tenant records, leases, rent, financials --
-- and can create, alter or drop any table in the schema. LimeAcademy is the
-- app where that matters most: it is the only one holding disability-adjacent
-- personal data (accommodations, in Phase 3), the only one with an
-- authenticated stored-content authoring surface, and the only one selling to
-- the public.
--
-- WHY THIS FILE LIVES IN shared-db AND NOT IN LimeAcademy'S OWN LEDGER.
-- LimeAcademy is a standalone business and reads no table it does not own, so
-- the original reason -- that this file granted one app access to another
-- app's data -- is gone. Two reasons remain, and they are enough:
--
--   * A ROLE is a cluster-level object, not a schema object. LimeAcademy's own
--     migrations are run twice, once into `public` and once into the
--     `limeacademy_test` schema, by a migration ledger that is per-schema. A
--     role has no schema to belong to and must not be created twice.
--   * Creating a role needs CREATEROLE, which neither `limeacademy_app` nor
--     `limeacademy_test_app` has and neither should get. This runs as the
--     shared migration credential, which is what shared-db is for.
--
-- ===========================================================================
-- PRECONDITION -- ORDER MATTERS
-- ===========================================================================
-- This file grants privileges on objects; those objects must already exist or
-- it aborts (harmlessly -- it is one transaction). Apply it only AFTER
-- LimeAcademy's own migrations 0000-0036 have run against `public`, so that
-- all of the following are present:
--
--     43 `la_*` tables
--      4 `la_v_*` views    la_v_learner_status        (0018, rebuilt 0020,
--                                                      0021 and 0033)
--                          la_v_learner_track_evidence (0020, rebuilt 0029)
--                          la_v_learner_lesson_time    (0021)
--                          la_v_item_difficulty        (0029)
--     30 `la_*` functions  plus the shared `set_updated_at()`
--     42 owned sequences   ONE FEWER THAN THE TABLE COUNT, and not an error.
--                          Every `la_*` table has a `bigserial` primary key
--                          except `la_enrollment_purchases`, which is keyed on
--                          `enrollment_id` so that a second receipt for one
--                          enrollment is unwritable rather than merely
--                          refused. It has no `id` column and therefore owns
--                          no sequence. Do not "fix" this to 43.
--
-- THE COUNTS ARE DERIVED, NOT REMEMBERED. `grantCoverage.test.ts` in
-- LimeAcademy reads the migrations directory and this file and fails the build
-- if they disagree, in either direction -- an object with no grant, or a grant
-- naming an object no migration creates. Do not adjust these numbers by
-- arithmetic; run that test.
--
-- Aborting on a missing object is the correct behaviour. A partially-granted
-- role would fail at runtime on whichever route happened to touch the missing
-- table first.
--
-- Migration 0033 DROPPED three tables this file used to grant on --
-- `la_identity_reviews`, `la_identity_links` and `la_role_track_assignments`.
-- All three existed only to reconcile LimeAcademy accounts against an external
-- staff directory. Every learner now registers with an email and a password,
-- so there is one door and nothing to reconcile. They are named here once
-- because a reader comparing this file against an older copy will want to know
-- the grants were removed deliberately rather than lost.
--
-- One 0020 column, `la_lesson_progress.instructional_seconds`, is a GENERATED
-- column. It is covered by the table-level grants below and needs no separate
-- treatment; nothing can write it, which is the point of it.
--
-- This migration creates the role and its grants ONLY. It does not change any
-- application's connection string. Nothing starts using this role until the
-- Owner/Broker sets a password and Scotty repoints DATABASE_URL -- see
-- "ROLLOUT" at the bottom. Applying this file alone is a no-op for every
-- running app.
--
-- ===========================================================================
-- THE PATTERN THIS FOLLOWS -- REUSED, NOT INVENTED
-- ===========================================================================
--   1. late-rent-notices migration 0017 (`late_rent_app` / `late_rent_job`)
--      -- the only production scoped roles actually running today. Source of
--      the "enumerate the tables, REVOKE DELETE, audit log gets INSERT+SELECT
--      only" shape used below.
--   2. map migration 0010 (`map_sync_job` / `map_staff_app`) -- source of the
--      explicit two-way fence: STATE THE REVOKES EVEN WHERE NOTHING WAS EVER
--      GRANTED, so isolation is a checkable statement rather than an
--      assumption. Applied five times below -- the permission catalog, the
--      attempt tables, the deployment config, the four commerce tables and the
--      audit log -- and again in the assertions in section 4.
--   3. The Oracle specification for scoping Limona's role (2026-07-25, never
--      implemented), for one decision this file inherits directly and which is
--      the load-bearing one:
--
--        TABLES STAY OWNED BY THE MIGRATION ROLE. The app role gets DML grants
--        only. Transferring ownership to the app role was considered there and
--        rejected, because AN OWNER CAN ALTER AND DROP ITS OWN TABLES -- which
--        reopens the exact "no DDL from the runtime connection" property this
--        whole change exists to guarantee. A role with every DML privilege on
--        a table it does not own cannot change the shape of it, cannot drop a
--        constraint that is enforcing a rule, and cannot remove the table.
--
-- That spec has three acknowledged gaps -- it never addressed TLS,
-- `search_path`, or what happens to tables created by FUTURE migrations. All
-- three are handled here, and Limona should adopt this file's answers when its
-- own role is finally cut (as 0005, same shape).
--
-- ===========================================================================
-- search_path -- WHAT THE ROLE-LEVEL SETTING IS AND IS NOT FOR
-- ===========================================================================
-- The application does not depend on it. `src/db/pool.ts` pins the schema per
-- connection with libpq `options: -c search_path=<DB_SCHEMA>`, and that
-- overrides the role-level setting on every connection the app opens.
--
-- The `ALTER ROLE ... SET search_path` below exists for connections that do
-- NOT come from the pool -- psql, a one-off script, a future job -- so that
-- they cannot get the implicit `"$user", public` default either.
--
-- What the GRANTS do, which is the part that matters: `limeacademy_app` holds
-- privileges on objects in `public` and nowhere else. The `limeacademy_test`
-- schema contains a complete copy of every `la_*` table. If DB_SCHEMA were
-- ever misconfigured in production, this role does not quietly start reading
-- and writing the test copy -- it gets `permission denied for schema` and
-- fails closed, loudly, on the first query. Neither mechanism is sufficient
-- alone: a pinned search_path can still be pinned to the wrong thing, and
-- grants alone still resolve by name.
--
-- ===========================================================================
-- TABLES ADDED BY FUTURE MIGRATIONS GET NOTHING, ON PURPOSE
-- ===========================================================================
-- `ALTER DEFAULT PRIVILEGES` would grant this role access to every table
-- created in `public` from now on. That is not narrower than what it replaces
-- -- `public` is shared with four other live applications, so it would hand
-- LimeAcademy automatic access to their future tables too. It is not an
-- option, and the fact that it would be convenient is not a reason.
--
-- So every object is enumerated, which means every object can be forgotten.
-- Phases 2-8 add roughly thirty more `la_*` tables, and each one needs a line
-- here (or in a follow-on grant migration -- never by editing this file once
-- it has been applied). What makes forgetting survivable is that it fails at
-- BUILD time rather than at runtime on whichever route touches the new table
-- first: `test/unit/grantCoverage.test.ts` reads both the migrations directory
-- and this file and compares them in both directions. That test is the reason
-- this enumeration is maintainable, and it must not be loosened to make a
-- build pass.
--
-- ===========================================================================
-- THE AUDIT LOG -- A HARD CONSTRAINT BOUGHT FOR FREE
-- ===========================================================================
-- `la_audit_log` is append-only by application convention only. LimeAcademy's
-- migration 0008 says so and says why: making it physically append-only in the
-- database would pick a winner between GOVERNANCE Rule 1 (append-only audit)
-- and HC-34 / Rule 10 (purge-on-departure, right to erasure), and that
-- question was expressly reserved for counsel.
--
-- With an unscoped superuser connection that convention was a property of
-- nothing at all -- one line of application code away from being false.
--
-- Below, `limeacademy_app` gets INSERT and SELECT on that table and not UPDATE
-- or DELETE. That makes append-only real FOR THE APPLICATION, which is the
-- only thing that was ever claiming to honor it -- and it does so WITHOUT
-- answering the counsel question, because it is a grant on one role, not a
-- trigger on the table. A separate administrative role can still delete under
-- a legal hold or a right-to-erasure decision, exactly as before, and whatever
-- counsel decides is implemented by a `GRANT`, not by rewriting a migration.
-- The reserved decision stays reserved; it just stops being enforced by
-- nothing.
--
-- Verified against the code before writing this: `src/lib/auditLog.ts` has one
-- INSERT and one SELECT and its header states no update or delete helper
-- exists or may be added; nothing anywhere in `src/` updates or deletes from
-- the table. The one DELETE is in `test/db/support/dbTestEnv.ts`, which runs
-- as `limeacademy_test_app` against `limeacademy_test` and is untouched by
-- this file. Nothing breaks.
--
-- ===========================================================================
-- WHAT THIS ROLE CANNOT DO -- THE LIST THAT MATTERS
-- ===========================================================================
--   * Cannot write `la_permissions`, `la_roles` or `la_role_permissions`. It
--     cannot invent a permission key and cannot change what a role MEANS for
--     everyone who holds it, so it cannot grant itself or anyone else a
--     privilege the migrations did not define.
--   * Cannot see ANY table outside LimeAcademy's own. Not Late Rent Notices,
--     Dashboard, Limona, LimeHQ or Map; not the six `pgmigrations*` ledgers;
--     not LimeHQ's `users` table, its staff password hashes or its 2FA seeds.
--     LimeAcademy reads no table it does not own, and this role could not
--     reach one if the application tried.
--   * Cannot create, alter or drop any table, index or constraint -- it has
--     USAGE but not CREATE on `public`, and it owns nothing.
--   * Cannot DELETE anywhere except `la_learner_roles`,
--     `la_learner_permission_overrides`, `la_discount_code_tracks` and the four
--     authoring collections listed in section 3, and cannot TRUNCATE anything
--     at all.
--   * Cannot UPDATE or DELETE `la_audit_log`, or DELETE any attempt record.
--   * Cannot rewrite what a course cost. `la_track_prices` is SELECT and INSERT
--     only, so a recorded price is unreachable from the runtime connection
--     whether or not its trigger is still installed.
--   * Cannot delete a receipt. `la_enrollment_purchases` is SELECT and INSERT
--     only -- what a named person paid for a course carrying DPOR credit
--     survives every later pricing decision and every dispute.
--   * Cannot log in at all until a password is set -- see the note below.
--
-- ===========================================================================
-- NO PASSWORD IS SET HERE, AND THAT IS A DEPARTURE FROM 0002/0003
-- ===========================================================================
-- Migrations 0002 and 0003 created their roles with the literal placeholder
-- 'CHANGE_ME_SEE_MIGRATION_HEADER'. That is a working credential for a real
-- login role, written into a committed file, live from the moment the
-- migration is applied until somebody remembers to rotate it.
--
-- This role is created with PASSWORD NULL instead. It cannot authenticate --
-- there is nothing to guess and nothing to rotate away from. The role exists
-- and holds its grants, and stays unusable until the Owner/Broker sets a
-- password directly:
--
--     ALTER ROLE limeacademy_app WITH PASSWORD '<generated by the Owner/Broker>';
--
-- run in the Supabase SQL editor, with the value going straight into the
-- password manager and LimeAcademy's git-ignored .env -- never into this file,
-- any other file, or any chat. This is the same handling used for the test
-- role's real password. The two earlier migrations should be brought to this
-- shape when their roles are next touched.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The role
-- ---------------------------------------------------------------------------
-- NOINHERIT is not decorative: it means that if some future migration grants
-- this role membership in another role, the privileges still do not apply to
-- ordinary queries without an explicit SET ROLE. NOBYPASSRLS is stated rather
-- than assumed -- late_rent_job and both Map roles carry BYPASSRLS, and this
-- role must not, because the row policies on the two permission-assignment
-- tables (migration 0024) are load-bearing and BYPASSRLS would void them.
--
-- CONNECTION LIMIT 40 is roughly four times the app's configured pool size
-- (node-postgres default max 10, src/db/pool.ts sets no override). It exists
-- so a connection leak in LimeAcademy exhausts LimeAcademy rather than the
-- shared pooler that rent collection also depends on. It fails in the right
-- direction: the blast radius of the limit being wrong is this app only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'limeacademy_app') THEN
    CREATE ROLE limeacademy_app
      LOGIN PASSWORD NULL
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
      CONNECTION LIMIT 40;
  END IF;
END
$$;

-- Membership in another role would silently undo every restriction below --
-- inheriting `postgres` or `service_role` hands back exactly the access this
-- file exists to remove. A newly created role is a member of nothing, so this
-- ASSERTS rather than revokes.
--
-- Asserting is deliberate. `REVOKE <role> FROM ...` requires ADMIN OPTION on
-- the role being revoked, and Supabase's managed `postgres` does not have that
-- on `supabase_admin` -- a blind revoke would abort this transaction on the
-- privilege check rather than on anything being wrong. It also means that if
-- this file is ever re-applied on a database where someone has since granted
-- membership, it stops and says so instead of quietly undoing their change.
DO $$
DECLARE memberships text;
BEGIN
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO memberships
    FROM pg_auth_members m
    JOIN pg_roles r      ON r.oid = m.roleid
    JOIN pg_roles member ON member.oid = m.member
   WHERE member.rolname = 'limeacademy_app';
  IF memberships IS NOT NULL THEN
    RAISE EXCEPTION
      'limeacademy_app is a member of: % -- every restriction in this migration is void while that is true. Revoke the membership deliberately, then re-apply.',
      memberships;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Start from nothing
-- ---------------------------------------------------------------------------
-- Blanket revoke FIRST, then grant precisely. Order matters -- doing this
-- after the grants would erase them. On a first application these are no-ops;
-- on a re-application they guarantee the end state is exactly what this file
-- describes and not this file plus whatever accumulated in between.
--
-- This is also the two-way fence at schema scope. Everything `public` holds
-- for the other four applications is revoked here by name of the schema rather
-- than left un-granted and assumed, and section 4b then asserts that none of
-- it came back.
REVOKE ALL ON SCHEMA public              FROM limeacademy_app;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM limeacademy_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM limeacademy_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM limeacademy_app;

-- USAGE lets names in `public` be resolved. It grants no access to any row --
-- that needs the per-object grants below, which this role has on its own 43
-- tables and 4 views and on nothing else in the schema. CREATE is deliberately
-- not granted: this role cannot add or change schema.
GRANT USAGE ON SCHEMA public TO limeacademy_app;

-- Belt to the pool's braces -- see the search_path note in the header.
ALTER ROLE limeacademy_app SET search_path = public;

-- ---------------------------------------------------------------------------
-- 3. LimeAcademy's tables
-- ---------------------------------------------------------------------------
-- Every object below is written `public.<name>`, never bare. A grant that
-- resolved by search_path would be a boundary made out of name resolution,
-- which is not a boundary.
--
-- 3a. Learners, content and delivery. Read/write, but no DELETE. Every
-- "removal" in this system is a status change or a new row: content is
-- versioned rather than edited, a merge adds a pointer and moves nothing, a
-- departure sets `status = 'departed'`. This matches late_rent_app and both
-- Map roles, none of which hold DELETE either.
GRANT SELECT, INSERT, UPDATE ON
  public.la_learners,
  public.la_tracks,
  public.la_modules,
  public.la_lessons,
  public.la_enrollments,
  public.la_privacy_notices,
  public.la_privacy_acknowledgments,
  public.la_lesson_versions,
  public.la_lesson_sources,
  public.la_curriculum_editions,
  public.la_edition_lessons,
  public.la_module_reviews,
  public.la_authoring_events,
  public.la_media_assets,
  public.la_reconciliation_tasks,
  public.la_lesson_progress,
  public.la_lesson_view_events
TO limeacademy_app;

-- ---------------------------------------------------------------------------
-- 3b. Identity and permissions (migrations 0023-0024, 0031).
--
-- LimeAcademy defines its own permission model and authenticates its own
-- customers. That is the whole product now, not a fallback, and it means the
-- single most valuable property this file secures -- THE RUNNING APPLICATION
-- CANNOT GRANT ITSELF A PERMISSION -- has to be built out of LimeAcademy's own
-- tables. It is the reason this section is not one GRANT line.
--
-- STRUCTURAL, SELECT ONLY. Seeded by migration, never written at runtime. The
-- app therefore cannot invent a permission key, and cannot change what a role
-- MEANS for everyone holding it. That second one is the sharp edge: write
-- access to `la_role_permissions` would let an admin add owner-only keys to the
-- admin row and escalate every admin at once. Postgres refuses it, and no
-- application bug can talk it round.
GRANT SELECT ON
  public.la_permissions,
  public.la_roles,
  public.la_role_permissions
TO limeacademy_app;

-- ASSIGNMENT, read/write. Putting a person into a role is an application
-- function, so these must be writable -- and they are the two tables where
-- escalation could live. Grants cannot express "any row except this one", so
-- the per-row bound is a row policy (migration 0024) keyed on `app_grantable`,
-- a column on the two tables above that the app cannot write. Net effect: the
-- app may assign roles, and may not grant `owner`, `records.export` (695),
-- `legal_hold.manage` (698), `remediation.terminate` (720) or
-- `remediation.goodwill` (730) to anybody, itself included.
--
-- DELETE is included because revoking a role or an override is a deletion, not
-- a status change -- the exception to this file's general no-DELETE posture,
-- and a narrow one: nothing a learner did is reachable through either table.
-- It is used: src/admin/peopleRoutes.ts removes a role assignment by row.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.la_learner_roles,
  public.la_learner_permission_overrides
TO limeacademy_app;

-- Credentials. The app authenticates, so it reads and writes them, including
-- `totp_secret` -- LimeAcademy's second factor is LimeAcademy's to verify.
--
-- NO DELETE. A credential is revoked by clearing its hash, not by removing the
-- row, so the learner keeps a credential record and the audit trail keeps its
-- subject.
GRANT SELECT, INSERT, UPDATE ON public.la_learner_credentials TO limeacademy_app;

-- Account tokens -- email verification and password reset. SELECT/INSERT/UPDATE
-- and deliberately NO DELETE: a token is spent by setting `consumed_at`, never
-- by removing the row, so the record that a reset happened survives the reset.
-- Withholding DELETE is what makes that structural rather than a convention the
-- application is trusted to keep.
--
-- Only a SHA-256 digest of each token is stored, so this grant conveys no
-- ability to spend a link even to something reading every row.
GRANT SELECT, INSERT, UPDATE ON public.la_learner_tokens TO limeacademy_app;

-- Stated twice, like the audit log, because this is the other restriction most
-- likely to be quietly undone by a later change.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  public.la_permissions, public.la_roles, public.la_role_permissions
FROM limeacademy_app;

-- ---------------------------------------------------------------------------
-- 3c. The assessment engine (migrations 0025-0029). The largest single batch of
-- tables the project adds, and therefore the most likely place to miss one --
-- which `grantCoverage.test.ts` turns into a build failure rather than a
-- permission-denied outage on whichever route touches the table first.
--
-- Content and authoring. Read/write, no DELETE: content is versioned and
-- retired, never removed, so a published question that was served to somebody
-- stays reachable for the DPOR seam.
GRANT SELECT, INSERT, UPDATE ON
  public.la_topics,
  public.la_stimuli,
  public.la_questions,
  public.la_question_versions,
  public.la_assessments
TO limeacademy_app;

-- The four authoring collections where removal IS the edit: an option struck
-- from a draft, a topic tag corrected, a blueprint row dropped, a topic
-- re-placed onto a different module. None of these is a record of anything a
-- learner did.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.la_topic_track_placement,
  public.la_question_options,
  public.la_question_topics,
  public.la_assessment_blueprint_rows
TO limeacademy_app;

-- Attempts. Read/write and DELIBERATELY NO DELETE, which is the grant-level
-- form of HC-15: no customer can delete their own failure history, and neither
-- can the application on anyone's behalf. Purging item detail on the short
-- retention tier is a scheduled, policy-driven job that fails closed on a legal
-- hold (Phase 3) -- it runs as a privileged role on its own connection, not as
-- the web application, and that separation is the point.
GRANT SELECT, INSERT, UPDATE ON
  public.la_attempts,
  public.la_attempt_items,
  public.la_attempt_integrity_events,
  public.la_module_state
TO limeacademy_app;

-- Single-row deployment config: readable, updatable, never inserted or deleted.
GRANT SELECT, UPDATE ON public.la_deployment_config TO limeacademy_app;

-- Stated rather than left to the absence of a GRANT, like the permission
-- catalog above and the audit log below. These are the two restrictions in the
-- assessment engine that a later change is most likely to undo by accident.
REVOKE DELETE, TRUNCATE ON
  public.la_attempts, public.la_attempt_items, public.la_attempt_integrity_events
FROM limeacademy_app;

REVOKE INSERT, DELETE, TRUNCATE ON public.la_deployment_config FROM limeacademy_app;

-- ---------------------------------------------------------------------------
-- 3d. Pricing, discount codes and receipts (migrations 0035-0036).
--
-- This is the money, and the grants here are doing more work than usual. Two of
-- the four tables are records of something that HAPPENED -- what we charged, and
-- what one named person paid for a course carrying DPOR credit -- and for those,
-- withholding a privilege is the point rather than a side effect.
--
-- PRICES: SELECT and INSERT, no UPDATE, no DELETE. `la_track_prices` is an
-- append-only price history: a price change is a new row, and editing a recorded
-- price is refused by `la_check_track_price_write`. The trigger already says so,
-- so why say it again in a grant? Because a trigger is a property of the TABLE
-- and a grant is a property of the CONNECTION. With UPDATE withheld, "the
-- application cannot rewrite what a course cost" stops depending on a trigger
-- staying installed and correct, and starts being true of the credential itself.
-- This is the same argument as the audit log, applied to the one other table
-- whose whole value is that it records the past accurately.
--
-- ONE CONSEQUENCE, STATED SO IT IS A CHOICE RATHER THAN A SURPRISE:
-- `la_check_track_price_write` deliberately permits UPDATE of the `note` column
-- ("a typo in the explanation is fixable and the number is not"). Withholding
-- UPDATE here makes that unreachable from the application connection -- notes are
-- write-once in practice. That is the accepted cost of the stronger property. If
-- editing a note ever has to work, it is a new grant migration adding
-- `UPDATE (note)` -- column-scoped, so the numbers stay unreachable -- and not a
-- widening of this line.
GRANT SELECT, INSERT ON public.la_track_prices TO limeacademy_app;

-- DISCOUNT CODES: SELECT, INSERT, UPDATE, no DELETE.
--
-- THE UPDATE GRANT IS NOT OPTIONAL AND IS NOT USED BY ANY STATEMENT IN `src/`.
-- Anyone auditing this by grepping the application for `UPDATE la_discount_codes`
-- will find nothing and conclude the grant is dead. It is not. Inserting an
-- enrollment that carries a code fires `la_redeem_discount_code_on_enrollment()`,
-- which is SECURITY INVOKER -- so it runs AS THIS ROLE -- and which does two
-- things needing UPDATE on this table:
--
--     SELECT dc.* FROM la_discount_codes dc WHERE ... FOR UPDATE;
--     UPDATE la_discount_codes SET redemption_count = redemption_count + 1 ...
--
-- (`SELECT ... FOR UPDATE` requires the UPDATE privilege in its own right, so
-- this is needed twice over.) Remove this grant and every enrollment carrying a
-- discount code fails with permission denied at the moment of purchase -- the
-- exact shape of the late-rent-notices 0017/0018 incident, on the checkout path.
--
-- No DELETE. A code that people came in on is how those enrollments are
-- reported; `fk_la_enrollments_discount_code` is RESTRICT for the same reason. A
-- code is retired by setting `active = false`, which the migration keeps editable
-- forever precisely so that deletion is never the way to switch one off.
GRANT SELECT, INSERT, UPDATE ON public.la_discount_codes TO limeacademy_app;

-- CODE SCOPE: SELECT, INSERT, DELETE. Unticking a course from a code is a
-- deletion -- there is no status to set on a row whose entire content is "this
-- code covers this course" -- and `la_check_discount_code_track_row` fires on
-- DELETE, so removal is a designed operation with a rule attached rather than an
-- oversight. It refuses once anybody has redeemed the code, which is where the
-- real protection sits. No UPDATE: repointing a scope row at a different course
-- is not an edit anybody needs, and it would be a way to move an entitlement onto
-- unlisted content without writing a new row for somebody to notice.
GRANT SELECT, INSERT, DELETE ON public.la_discount_code_tracks TO limeacademy_app;

-- RECEIPTS: SELECT and INSERT. DELETE IS WITHHELD, AND THAT IS THE WHOLE POINT
-- OF THE LINE -- a receipt that can be deleted is not a receipt. On a course
-- carrying DPOR credit that may be sold to strangers, "what did this person
-- actually pay" has one real answer that has to survive every later pricing
-- decision and every later dispute.
--
-- THE GRANT IS THE RIGHT PLACE FOR THIS RATHER THAN A TRIGGER. A BEFORE DELETE
-- trigger that raised would bind the table for everybody, including fixture
-- teardown in the test suite, which has to be able to tear a scratch dataset
-- down. Withholding DELETE from ONE ROLE makes the receipt permanent for the
-- application without making the table impossible to clean up as anything else,
-- which is the same distinction the audit log turns on.
--
-- No UPDATE either. `la_check_purchase_immutable` freezes every column except
-- `updated_at`, and the migration says UPDATE is left unrefused only so that a
-- future settlement migration can move that one column. When that migration
-- lands it adds its own grant; until then there is nothing for the application
-- to update and no reason for it to hold the privilege.
GRANT SELECT, INSERT ON public.la_enrollment_purchases TO limeacademy_app;

-- The two-way fence again, on the four restrictions above that a later change is
-- most likely to undo by accident. Stated even though nothing granted them.
REVOKE UPDATE, DELETE, TRUNCATE ON public.la_track_prices          FROM limeacademy_app;
REVOKE DELETE, TRUNCATE         ON public.la_discount_codes        FROM limeacademy_app;
REVOKE UPDATE, TRUNCATE         ON public.la_discount_code_tracks  FROM limeacademy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON public.la_enrollment_purchases  FROM limeacademy_app;

-- ---------------------------------------------------------------------------
-- 3e. The audit log. INSERT and SELECT, deliberately nothing else -- see "THE
-- AUDIT LOG" above for why this is the one place scoping buys a hard
-- constraint without settling the question reserved for counsel.
GRANT INSERT, SELECT ON public.la_audit_log TO limeacademy_app;

-- Stated, not assumed. `la_audit_log` is the row of this file most likely to
-- be quietly undone by a later change, so its restriction is written twice.
-- The second line targets PUBLIC (every role). It is a no-op today -- tables
-- grant nothing to PUBLIC by default and migration 0001 already removed
-- anon/authenticated -- and it does NOT bind the table's owner, so the
-- administrative path counsel may need stays exactly where it was.
REVOKE UPDATE, DELETE, TRUNCATE ON public.la_audit_log FROM limeacademy_app;
REVOKE UPDATE, DELETE, TRUNCATE ON public.la_audit_log FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3f. The four views. All read-only, and none of them can be made otherwise
-- from here.
--
-- `la_v_learner_status` is the staff-facing roster view. It has no score column
-- and no join path to one; that is a property of the view definition, not of
-- this grant.
GRANT SELECT ON public.la_v_learner_status TO limeacademy_app;

-- The dispute-evidence view (0020, rebuilt 0029). Aggregates delivery evidence
-- -- first access, lessons opened, accumulated time, generation count -- across
-- EVERY enrollment generation for a learner on a track.
--
-- Read-only here for the same reason `la_audit_log` is INSERT-only: this is
-- the merchant's own defence in a chargeback, and Mason's position is that the
-- no-refund policy's enforceability rests on the purchase disclosure plus
-- these access records. No remediation action may modify or delete what it
-- reads, and no application route needs to. A reset creates a new generation;
-- it never reaches backwards.
GRANT SELECT ON public.la_v_learner_track_evidence TO limeacademy_app;

-- Migration 0021. Seat time for one PERSON on one lesson version, summed across
-- every enrollment chain whose work still counts -- reset chains excluded,
-- merge-closed chains included. Read-only, and read INSTEAD of
-- `la_lesson_progress` wherever the question is about a person rather than a
-- single enrollment: the minimum-time gate, progress display and completion.
GRANT SELECT ON public.la_v_learner_lesson_time TO limeacademy_app;

-- Migration 0029. Per-question difficulty for item rotation. It reads the
-- stored counters on `la_question_versions` and never touches an attempt, so it
-- has no join path to a learner -- structurally anonymous rather than anonymous
-- by policy.
GRANT SELECT ON public.la_v_item_difficulty TO limeacademy_app;

-- ---------------------------------------------------------------------------
-- 3g. Sequences. Nearly every primary key in LimeAcademy is `bigserial`, so
-- nearly every INSERT above needs USAGE on that table's owned sequence.
-- Enumerated via OWNERSHIP rather than `ALL SEQUENCES IN SCHEMA public`, which
-- is what late_rent_app was given and which reaches every other app's sequences
-- too.
--
-- The loop finds 42 sequences for 43 tables. `la_enrollment_purchases` is keyed
-- on `enrollment_id` rather than a generated `id`, so it owns none and needs
-- none -- see the precondition at the top before concluding one is missing.
--
-- This loop is the one place a future `la_*` table is picked up automatically,
-- and it is safe to let it be: a sequence is a counter, not data, and it is
-- reachable only by something that already holds INSERT on the table that owns
-- it -- which this file still has to grant by hand.
DO $$
DECLARE
  seq record;
BEGIN
  FOR seq IN
    SELECT format('%I.%I', n.nspname, s.relname) AS name
      FROM pg_class s
      JOIN pg_depend d      ON d.objid = s.oid
                           AND d.classid    = 'pg_class'::regclass
                           AND d.refclassid = 'pg_class'::regclass
      JOIN pg_class t       ON t.oid = d.refobjid
      JOIN pg_namespace n   ON n.oid = s.relnamespace
      JOIN pg_namespace tn  ON tn.oid = t.relnamespace
     WHERE s.relkind = 'S'
       AND n.nspname  = 'public'
       AND tn.nspname = 'public'
       AND d.deptype = 'a'          -- 'a' = the auto-dependency bigserial creates
       AND t.relname LIKE 'la\_%'
  LOOP
    EXECUTE format('GRANT USAGE ON SEQUENCE %s TO limeacademy_app', seq.name);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 3h. Trigger and helper functions.
--
-- `set_updated_at()` is the shared updated-at trigger in `public`, which
-- LimeAcademy's migration 0000 creates only if it is not already there rather
-- than replacing another app's copy. EXECUTE on a function conveys no access to
-- any row.
--
-- These grants are no-ops today because PUBLIC still holds EXECUTE on functions
-- by default; they are written so this role keeps working if that default is
-- ever revoked, and because the deferred CONSTRAINT triggers among them run at
-- COMMIT as this role.
GRANT EXECUTE ON FUNCTION public.set_updated_at()                          TO limeacademy_app;

-- Migrations 0001-0020.
GRANT EXECUTE ON FUNCTION public.la_purge_text_selection_on_departure()    TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_learner_merge_target()           TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_edition_series_rules()           TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_media_provenance_track_scope()   TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_enrollment_invariants()          TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_seat_time_grants()               TO limeacademy_app;

-- Migration 0021. The first is a plain helper the other two call; the two
-- constraint triggers are DEFERRABLE INITIALLY DEFERRED.
GRANT EXECUTE ON FUNCTION public.la_assert_one_live_enrollment(bigint)     TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_enrollment_live_uniqueness()     TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_learner_live_enrollments()       TO limeacademy_app;

-- Migrations 0025-0027. Three are deferred constraint triggers; two are the
-- helpers they call.
GRANT EXECUTE ON FUNCTION public.la_assert_core_prefix(bigint)             TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_module_core_prefix()             TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_question_primary_topic()         TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_assert_assessment_publishable(bigint)  TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_assessment_publishable()         TO limeacademy_app;

-- Migrations 0030-0032. Session revocation, token finality, and the two rules
-- that keep an enrollment on a sellable track. These fire on tables this role
-- writes on every sign-in and every purchase, so a missing EXECUTE here would
-- be an outage on the busiest paths in the app.
GRANT EXECUTE ON FUNCTION public.la_check_session_version_monotonic()          TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_bump_session_version_on_credential_change() TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_token_consumption_final()            TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_enrollment_track_is_offerable()      TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_track_proprietary_reclassification() TO limeacademy_app;

-- Migrations 0035-0036. Pricing and discount codes: four helpers and seven
-- trigger functions.
--
-- ALL ELEVEN ARE SECURITY INVOKER -- none carries SECURITY DEFINER -- so every
-- one of them runs as `limeacademy_app` and reads and writes under this role's
-- grants, not the table owner's. That is why section 3d has to grant UPDATE on
-- `la_discount_codes` even though no statement in `src/` updates it: the
-- redemption counter is incremented by a trigger, as this role.
--
-- `grantCoverage.test.ts` checks tables and views and NOT functions, so nothing
-- automated catches an omission here. The four helpers are called by the quote
-- on the catalog page and by the purchase trigger alike; the seven triggers fire
-- on enrollment creation and on every write to a price, a code or a receipt.
GRANT EXECUTE ON FUNCTION public.la_track_current_price_id(bigint, timestamptz)      TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_track_price_usd_cents(bigint, timestamptz)       TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_discount_code_scope_for_track(bigint, bigint)    TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_discount_charge_usd_cents(integer, bigint)       TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_track_price_write()                        TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_discount_code_terms()                      TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_discount_code_track_row()                  TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_assert_discount_code_scope()                     TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_redeem_discount_code_on_enrollment()             TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_price_enrollment_purchase()                      TO limeacademy_app;
GRANT EXECUTE ON FUNCTION public.la_check_purchase_immutable()                       TO limeacademy_app;

-- ---------------------------------------------------------------------------
-- 4. Prove it, in the same transaction
-- ---------------------------------------------------------------------------
-- These checks run against the state this file has just created and abort the
-- whole transaction if any of them is wrong. They exist because migration 0018
-- of late-rent-notices is on the record as the cautionary tale: 0017's grants
-- missed three tables the daily job actually read, and it was not caught
-- because testing ran against a superuser connection instead of the real role.
-- A migration that grants privileges should not be able to be wrong quietly.
--
-- The same three queries can be run read-only at any time afterwards as an
-- audit.

-- 4a. Positive: every la_ table and view is reachable.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO missing
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
     AND c.relname LIKE 'la\_%'
     AND NOT has_table_privilege('limeacademy_app', c.oid, 'SELECT');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'limeacademy_app cannot SELECT its own tables: %', missing;
  END IF;
END
$$;

-- 4b. Negative: NOTHING outside LimeAcademy's own objects is reachable at all.
-- There is no exclusion list, and there is not meant to be one -- LimeAcademy
-- is standalone and reads no table it does not own, so any relation in `public`
-- not named `la_*` that this role can touch is a defect by definition. This is
-- the check that catches a future stray grant, and the whole shape of the
-- problem this file was written to fix.
DO $$
DECLARE stray text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO stray
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p')
     AND c.relname NOT LIKE 'la\_%'
     AND (has_table_privilege('limeacademy_app', c.oid, 'SELECT')
       OR has_table_privilege('limeacademy_app', c.oid, 'INSERT')
       OR has_table_privilege('limeacademy_app', c.oid, 'UPDATE')
       OR has_table_privilege('limeacademy_app', c.oid, 'DELETE'));
  IF stray IS NOT NULL THEN
    RAISE EXCEPTION 'limeacademy_app reaches tables it must not: %', stray;
  END IF;
END
$$;

-- 4c. Negative, named: the specific things this migration exists to make
-- impossible. Written out one by one because "no privilege escalation" and
-- "append-only" are the claims this file will be read to verify, and they
-- should each fail loudly and by name rather than as one line of 4b's output.
DO $$
BEGIN
  -- The escalation guarantee. If any of these three becomes writable, the
  -- running application can define its own permissions or redefine what a role
  -- means -- which is the property this whole file exists to hold.
  IF has_table_privilege('limeacademy_app', 'public.la_permissions',      'INSERT')
     OR has_table_privilege('limeacademy_app', 'public.la_permissions',      'UPDATE')
     OR has_table_privilege('limeacademy_app', 'public.la_permissions',      'DELETE')
     OR has_table_privilege('limeacademy_app', 'public.la_roles',            'INSERT')
     OR has_table_privilege('limeacademy_app', 'public.la_roles',            'UPDATE')
     OR has_table_privilege('limeacademy_app', 'public.la_roles',            'DELETE')
     OR has_table_privilege('limeacademy_app', 'public.la_role_permissions', 'INSERT')
     OR has_table_privilege('limeacademy_app', 'public.la_role_permissions', 'UPDATE')
     OR has_table_privilege('limeacademy_app', 'public.la_role_permissions', 'DELETE') THEN
    RAISE EXCEPTION
      'limeacademy_app can write its own permission catalog -- it could grant itself any permission';
  END IF;

  -- The row policies are the other half of that guarantee, and an ENABLE that
  -- silently went missing would leave the two writable tables unbounded.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.la_learner_roles'::regclass AND relrowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.la_learner_permission_overrides'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION
      'row level security is not enabled on the permission assignment tables -- app_grantable is unenforced';
  END IF;

  IF has_table_privilege('limeacademy_app', 'public.la_audit_log', 'UPDATE')
     OR has_table_privilege('limeacademy_app', 'public.la_audit_log', 'DELETE') THEN
    RAISE EXCEPTION 'la_audit_log is not append-only for limeacademy_app';
  END IF;

  -- Nobody may delete an attempt, including the person who failed it.
  IF has_table_privilege('limeacademy_app', 'public.la_attempts',                  'DELETE')
     OR has_table_privilege('limeacademy_app', 'public.la_attempt_items',             'DELETE')
     OR has_table_privilege('limeacademy_app', 'public.la_attempt_integrity_events',  'DELETE') THEN
    RAISE EXCEPTION 'limeacademy_app can delete attempt history -- HC-15 is unenforced';
  END IF;

  -- Credentials are revoked by clearing the hash, and a spent token stays spent.
  IF has_table_privilege('limeacademy_app', 'public.la_learner_credentials', 'DELETE')
     OR has_table_privilege('limeacademy_app', 'public.la_learner_tokens',      'DELETE') THEN
    RAISE EXCEPTION 'limeacademy_app can delete credential or token rows -- the reset trail is erasable';
  END IF;

  -- The money. Both of these are the grant-level half of a rule a trigger also
  -- enforces, and they are named separately because "the price history is
  -- append-only" and "a receipt cannot be deleted" are claims somebody will read
  -- this file to verify.
  IF has_table_privilege('limeacademy_app', 'public.la_track_prices', 'UPDATE')
     OR has_table_privilege('limeacademy_app', 'public.la_track_prices', 'DELETE') THEN
    RAISE EXCEPTION
      'limeacademy_app can rewrite a recorded price -- every past purchase would read as though it cost the new amount';
  END IF;

  IF has_table_privilege('limeacademy_app', 'public.la_enrollment_purchases', 'UPDATE')
     OR has_table_privilege('limeacademy_app', 'public.la_enrollment_purchases', 'DELETE') THEN
    RAISE EXCEPTION
      'limeacademy_app can alter or delete a purchase record -- a receipt that can be edited is not a receipt';
  END IF;

  -- The other direction, and the one an over-tightening would break rather than
  -- loosen: redeeming a code INCREMENTS its counter from inside a SECURITY
  -- INVOKER trigger, so this role genuinely needs UPDATE here. Asserted because
  -- the grant looks unused to anyone grepping the application for it, which
  -- makes it exactly the line a future tidy-up removes -- and the failure would
  -- land on the checkout path in production.
  IF NOT has_table_privilege('limeacademy_app', 'public.la_discount_codes', 'UPDATE') THEN
    RAISE EXCEPTION
      'limeacademy_app cannot UPDATE la_discount_codes -- every enrollment carrying a discount code will fail: la_redeem_discount_code_on_enrollment() locks the row FOR UPDATE and increments redemption_count as this role';
  END IF;

  IF pg_has_role('limeacademy_app', 'postgres', 'USAGE') THEN
    RAISE EXCEPTION 'limeacademy_app inherits postgres -- every restriction above is void';
  END IF;
END
$$;

COMMIT;

-- ===========================================================================
-- ROLLOUT -- none of this happens by applying this file
-- ===========================================================================
-- Applying this migration changes nothing for any running application. The
-- role exists, holds its grants, and cannot log in. The remaining steps are
-- ordered so that each one is separately reversible.
--
--   1. Owner/Broker sets the password (see the password note at the top) and
--      stores it in the password manager. Nobody else handles the value.
--
--   2. The migration connection is ALREADY separated from the runtime
--      connection -- this was step 2 when the file was first written and Q has
--      since done it. The four `migrate:*` scripts pass
--      `-d MIGRATION_DATABASE_URL`, and `src/scripts/assertProductionMigration.ts`
--      refuses to run if that variable is unset rather than falling back to
--      DATABASE_URL. What remains is one line: `.env.example` documents
--      DATABASE_URL and not MIGRATION_DATABASE_URL, so the split is real in
--      code and undocumented for whoever sets up the next environment.
--
--      After DATABASE_URL is repointed at `limeacademy_app`, the running
--      application physically cannot alter its own schema: the credential that
--      can is not present in its environment.
--
--   3. Q turns on real TLS. The mechanism already exists in `src/db/pool.ts` --
--      `DB_SSL_MODE=verify-full` plus `DB_SSL_CA_FILE` pointing at Supabase's
--      CA bundle, which is not in any system trust store and must be shipped
--      with the deploy. `NODE_ENV=production` already REFUSES both `disable`
--      and `require`, so this is not optional: obtaining the CA bundle is an
--      infrastructure task that blocks go-live, not a hardening nicety.
--
--      `require` -- the default -- is node-postgres `{ rejectUnauthorized:
--      false }`: encrypted, but the server's identity is never checked. That
--      stops passive eavesdropping and does NOT stop anyone who can redirect
--      the connection, who would be handed this role's password on the first
--      handshake. The pooler accepts plaintext, so nothing server-side will
--      refuse a misconfiguration.
--
--   4. TARS verifies, against the real database, connected AS
--      `limeacademy_app`:
--        - TLS, via `observeTls()` in src/db/pool.ts and NOT via pg_stat_ssl.
--          Measured on 2026-08-14: Supavisor terminates TLS, so pg_stat_ssl
--          describes the pooler-to-Postgres hop and answers `ssl = false` even
--          on a connection whose client socket is a verified TLSv1.3 socket.
--          A check built on pg_stat_ssl fails closed on an unobservable
--          condition, which is an outage rather than a safety feature.
--        - the three audit blocks in section 4 above still pass.
--        - a full click-through of every authenticated route. Permission-denied
--          errors surface at runtime, not at deploy, and the app has ~30 more
--          tables coming in Phases 2-8 -- each of which needs a grant added
--          here. `grantCoverage.test.ts` is the standing check that catches
--          that at build time; this click-through is what catches a grant that
--          exists but is too narrow.
--
--   5. Do not disable or rotate the shared `postgres` role. Keep its
--      connection string for one to two weeks as the rollback path. Rolling
--      back is putting the old value in `DATABASE_URL` and restarting; no data
--      changes either way.
