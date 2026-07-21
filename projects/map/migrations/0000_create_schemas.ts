import type { MigrationBuilder } from "node-pg-migrate";

// Architecture Correction (Neo, schema.md): Map is NOT a separate Supabase
// project/database. It shares the same project (ref qafzhvccodchweeebovd)
// as late-rent-notices/Dashboard/Limona/LimeHQ, isolated by dedicated
// Postgres schemas instead — `map` (internal) and `map_public` (anonymous,
// structurally minimal). This migration only creates the two schemas.
//
// pgcrypto and the shared public.set_updated_at() trigger function already
// exist in this project's `public` schema (created once, by late-rent-
// notices' migration 0000) — Map's migrations reference
// `public.set_updated_at` by its fully-qualified name rather than
// redefining a second copy, per the standing rule against duplicating
// shared logic.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createSchema("map", { ifNotExists: true });
  pgm.createSchema("map_public", { ifNotExists: true });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropSchema("map_public", { ifExists: true, cascade: true });
  pgm.dropSchema("map", { ifExists: true, cascade: true });
}
