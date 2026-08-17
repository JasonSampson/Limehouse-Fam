# shared-db

This folder holds migrations that don't belong to any single app.

Every other `migrations/` folder in this ecosystem (`projects/late-rent-notices`,
`projects/map`, and the sibling repos for Dashboard/LimeHQ/Limona) is scoped to
that app's own tables, in that app's own schema, run by that app's own
node-pg-migrate config. That works fine as long as a fix only ever touches
tables one app owns.

This folder is for the other case: a fix that applies to the shared Supabase
project itself (ref `qafzhvccodchweeebovd`) — schema-wide grants, roles that
span apps, or the `public` schema as a whole — where picking one app's
migration folder to "own" the change would be misleading (the next person
reading late-rent-notices' migration history shouldn't have to guess that a
Dashboard/LimeHQ/Limona security fix is hiding in there).

Files here are plain `.sql`, run directly with `psql` against the shared
project's connection string — not through any single app's node-pg-migrate
runner, since no single app's runner should be the source of truth for a
change that isn't about that app's own data.

## Migrations

- `0001_lockdown_public_schema_anon_access` — closes a live vulnerability
  Sentinel found while reviewing Map's public-site launch: the shared
  project's `public` schema (Late Rent Notices, LimeHQ, Dashboard, and
  Limona's tables) still had Supabase's default `anon`/`authenticated`
  grants in place. See the file header for full detail and the confirmation
  that none of the four apps use that access path.
- `0002_create_limona_test_schema` — replaces Limona's old Docker-based
  disposable test database with a dedicated `limona_test` schema + a
  scoped `limona_test_app` role inside this same shared project (a second
  Supabase project for test data was considered and rejected, to avoid
  multiplying the number of projects that need securing). Written as a
  reusable pattern — other projects wanting the same Docker-free test setup
  can add their own `<project>_test` schema + role as a follow-up migration
  here, same shape.
- `0003_create_limeacademy_test_schema` — the first project to take up 0002's
  pattern: a `limeacademy_test` schema + `limeacademy_test_app` role for
  LimeAcademy's disposable test database.
- `0004_create_limeacademy_app_role_and_grants` — creates `limeacademy_app`,
  the scoped **production** role LimeAcademy connects as, replacing the shared
  Supabase `postgres` superuser. It gets read/write on its own 20 `la_*`
  tables, **read-only** on the five LimeHQ tables its auth path needs (with a
  column-scoped grant on `public.users` that withholds `password_hash` and
  `totp_secret`), and nothing else anywhere. Specifically it cannot write to
  `public.user_permission_overrides` — the write that would let one app grant
  itself any permission in the ecosystem. Applying it changes nothing for any
  running app: the role is created with **no password** and cannot log in
  until the Owner/Broker sets one. See the file header for the rollout order
  and for why table grants were chosen over a view contract.

  This is the first *production* role in this folder and the shape is meant to
  be reused. Three apps still connect as `postgres` — Limona (spec written
  2026-07-25, never implemented), LimeHQ, and Dashboard. Each should get the
  same treatment as a follow-up here rather than a second pattern. Note that
  LimeHQ's own `.env.example` already documents a `limehq_app` role that no
  migration has ever created.
