import type { MigrationBuilder } from "node-pg-migrate";

// Defensive-in-depth: enable Row Level Security on every table, with
// deliberately ZERO policies for the Supabase `anon`/`authenticated` roles.
//
// Why this is needed even though nothing is exposed today: this project's
// database is Supabase-hosted Postgres, and the app only ever connects as
// the `limona_app` table-owner role via DATABASE_URL (see src/db/pool.ts,
// which hands the connection string straight to `pg.Pool` — never through
// Supabase's client library or its public anon-key REST layer). Postgres
// leaves RLS OFF by default on new tables, so if any future feature ever
// used the Supabase client library with the anon key directly, these tables
// would be instantly fully readable/writable by anyone holding that
// semi-public-by-design key, with no warning. Enabling RLS now, with no
// policies granted to anon/authenticated, makes that hypothetical future
// mistake fail closed (zero rows returned) instead of failing open.
//
// Why this cannot break anything the app does today: table owners bypass
// RLS entirely, by Postgres design, regardless of how many (or how few)
// policies exist. `limona_app` created every one of these tables via
// migrations 0001-0007, making it the owner of all seven, so every
// query/insert/update/delete this app performs today continues to work
// exactly as before. This migration only changes behavior for the
// `anon`/`authenticated` Supabase roles, which the app never uses.
//
// No first-class pgm helper exists for RLS, so this uses pgm.sql (same
// approach as the seed INSERT in migration 0002).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE users ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE document_categories ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE documents ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE chat_queries ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE assets ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE team_knowledge ENABLE ROW LEVEL SECURITY;`);

  // No policies are created for anon/authenticated on purpose: RLS enabled
  // + zero policies = those roles get zero rows back on every operation.
  // That "deny by default" outcome is the entire point of this migration.
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE users DISABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE document_categories DISABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE documents DISABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE document_chunks DISABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE chat_queries DISABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE assets DISABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE team_knowledge DISABLE ROW LEVEL SECURITY;`);
}
