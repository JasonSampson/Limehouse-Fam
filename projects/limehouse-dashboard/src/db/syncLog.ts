import { getPool } from "./pool.js";

// Data-access layer over dashboard_sync_log (Neo's migration 0005).
// Append-only: every sync attempt gets its own row, started here and
// completed there — "last synced" is always computed as the most recent
// row WHERE status = 'succeeded', never just the most recent row
// regardless of outcome (per Neo's migration comment).
export type SyncSource = "buildium" | "rent_engine" | "lead_simple";
export type SyncStatus = "running" | "succeeded" | "failed";

export async function startSyncRun(sourceSystem: SyncSource, syncType: string, traceId?: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO dashboard_sync_log (source_system, sync_type, started_at, status, trace_id)
     VALUES ($1, $2, now(), 'running', $3)
     RETURNING id`,
    [sourceSystem, syncType, traceId ?? null]
  );
  return rows[0].id;
}

export async function completeSyncRun(syncLogId: number, recordsSynced: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE dashboard_sync_log SET completed_at = now(), status = 'succeeded', records_synced = $2 WHERE id = $1`,
    [syncLogId, recordsSynced]
  );
}

export async function failSyncRun(syncLogId: number, errorMessage: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE dashboard_sync_log SET completed_at = now(), status = 'failed', error_message = $2 WHERE id = $1`,
    [syncLogId, errorMessage]
  );
}

export interface LastSyncInfo {
  sourceSystem: SyncSource;
  completedAt: Date;
  recordsSynced: number | null;
}

export async function getLastSuccessfulSync(sourceSystem: SyncSource): Promise<LastSyncInfo | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT source_system, completed_at, records_synced
     FROM dashboard_sync_log
     WHERE source_system = $1 AND status = 'succeeded'
     ORDER BY completed_at DESC LIMIT 1`,
    [sourceSystem]
  );
  if (rows.length === 0) return null;
  return {
    sourceSystem: rows[0].source_system,
    completedAt: rows[0].completed_at,
    recordsSynced: rows[0].records_synced,
  };
}
