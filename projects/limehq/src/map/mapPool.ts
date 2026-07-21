import pg from "pg";
import { loadEnv } from "../config/env.js";

// A second, separate pool from src/db/pool.ts's getAppPool(). LimeHQ's own
// pool connects to the shared Supabase project's `public` schema (users,
// role_templates, permission_catalog, etc.) with a role that has zero
// grants on Map's `map`/`map_public` schemas — that isolation is
// intentional (Limehouse-Fam/projects/map/docs/schema.md's "Enforcing the
// Public/Internal Split") and this file does not undo it. This pool
// connects as the `map_staff_app` role instead, which has the opposite
// shape: read access to every table in `map`, write access scoped to
// `map.property_exclusions` and `map.named_area_exclusions` (per that
// project's migrations 0010 and 0015), and zero grants on `public` — so it
// cannot see LimeHQ's/Late Rent Notices'/Dashboard's/Limona's tables
// either. `map_staff_app` has `search_path = map` set at the role level, so
// queries against this pool use unqualified table names (`properties`, not
// `map.properties`) exactly the way Map's own sync-job code does.
//
// Resolving "who flagged this" (a user's display name) is NOT this pool's
// job — property_exclusions.flagged_by_user_id/named_area_exclusions.
// created_by_user_id are bare bigints referencing public.users(id), a table
// this role cannot see. Routes that need a display name look it up via
// getAppPool() (src/db/pool.ts) separately and join the two result sets in
// application code — see src/map/mapQueries.ts's resolveDisplayNames().
let pool: pg.Pool | undefined;

/** Returns null (not a pool) when MAP_DATABASE_URL isn't configured, so
 * callers can render a clear "Map isn't set up yet" state instead of the
 * whole app crashing on a missing env var in a dev environment. */
export function getMapPool(): pg.Pool | null {
  const env = loadEnv();
  if (!env.MAP_DATABASE_URL) return null;
  if (!pool) {
    pool = new pg.Pool({ connectionString: env.MAP_DATABASE_URL });
  }
  return pool;
}

export function isMapConfigured(): boolean {
  return Boolean(loadEnv().MAP_DATABASE_URL);
}
