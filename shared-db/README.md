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
