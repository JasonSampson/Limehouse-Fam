import { getPool } from "./pool.js";

// Thin data-access layer over dashboard_metric_cache (Neo's migration
// 0004). This is a 5-15 minute cache for live pass-through tiles — NOT a
// history table. Per Neo's migration comment: a failed refresh must NEVER
// delete the cached row (that would make a working tile go blank on a
// transient API hiccup); it must keep the last-known-good value and record
// the failure so the UI can show "last updated X ago, refresh failed."
export interface CachedMetric {
  metricKey: string;
  scope: string;
  sourceSystem: "buildium" | "rent_engine" | "lead_simple" | "google";
  value: unknown;
  fetchedAt: Date;
  lastError: string | null;
  lastErrorAt: Date | null;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes, within the 5-15 min brief

export async function getCachedMetric(metricKey: string, scope = "portfolio"): Promise<CachedMetric | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT metric_key, scope, source_system, value, fetched_at, last_error, last_error_at
     FROM dashboard_metric_cache WHERE metric_key = $1 AND scope = $2`,
    [metricKey, scope]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    metricKey: r.metric_key,
    scope: r.scope,
    sourceSystem: r.source_system,
    value: r.value,
    fetchedAt: r.fetched_at,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
  };
}

export function isCacheFresh(metric: CachedMetric): boolean {
  return Date.now() - metric.fetchedAt.getTime() < CACHE_TTL_MS;
}

// Successful refresh: overwrite value + fetched_at, clear any prior error.
export async function upsertCachedMetric(
  metricKey: string,
  scope: string,
  sourceSystem: "buildium" | "rent_engine" | "lead_simple" | "google",
  value: unknown
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO dashboard_metric_cache (metric_key, scope, source_system, value, fetched_at, last_error, last_error_at)
     VALUES ($1, $2, $3, $4, now(), NULL, NULL)
     ON CONFLICT (metric_key, scope) DO UPDATE
       SET source_system = EXCLUDED.source_system,
           value = EXCLUDED.value,
           fetched_at = EXCLUDED.fetched_at,
           last_error = NULL,
           last_error_at = NULL`,
    [metricKey, scope, sourceSystem, JSON.stringify(value)]
  );
}

// Failed refresh: record the error WITHOUT touching value/fetched_at, so the
// last-known-good value keeps serving. If no row exists yet (first-ever
// fetch failed), there is nothing to preserve — insert an errored row with
// a null value so the UI can render "never synced, last attempt failed."
export async function recordCacheRefreshFailure(
  metricKey: string,
  scope: string,
  sourceSystem: "buildium" | "rent_engine" | "lead_simple" | "google",
  errorMessage: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO dashboard_metric_cache (metric_key, scope, source_system, value, fetched_at, last_error, last_error_at)
     VALUES ($1, $2, $3, 'null'::jsonb, now(), $4, now())
     ON CONFLICT (metric_key, scope) DO UPDATE
       SET last_error = EXCLUDED.last_error,
           last_error_at = EXCLUDED.last_error_at`,
    [metricKey, scope, sourceSystem, errorMessage]
  );
}
