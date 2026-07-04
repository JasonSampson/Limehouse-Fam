import { Router } from "express";
import { isRentEngineConnected, isLeadSimpleConnected } from "../config/env.js";
import { fetchOutstandingBalances, fetchProperties } from "../buildium/client.js";
import { upsertCachedMetric, recordCacheRefreshFailure } from "../db/metricCache.js";
import { startSyncRun, completeSyncRun, failSyncRun, getLastSuccessfulSync } from "../db/syncLog.js";
import { summarizeDelinquency } from "../buildium/delinquency.js";
import { logError, logInfo } from "../lib/logger.js";

export const syncRoutes = Router();

// Reports which sources are actually usable right now, and when each one
// last succeeded (never just "last attempted" — see src/db/syncLog.ts).
// Frontend uses this to show "RentEngine: not connected" vs "Buildium: last
// synced 4 minutes ago" instead of guessing.
syncRoutes.get("/api/sync/status", async (_req, res) => {
  try {
    const [buildium, rentEngine, leadSimple] = await Promise.all([
      getLastSuccessfulSync("buildium"),
      getLastSuccessfulSync("rent_engine"),
      getLastSuccessfulSync("lead_simple"),
    ]);
    res.json({
      buildium: { connected: true, lastSyncedAt: buildium?.completedAt ?? null },
      rentEngine: { connected: isRentEngineConnected(), lastSyncedAt: rentEngine?.completedAt ?? null },
      leadSimple: { connected: isLeadSimpleConnected(), lastSyncedAt: leadSimple?.completedAt ?? null },
    });
  } catch (err) {
    logError("GET /api/sync/status failed", { error: String(err) });
    res.status(500).json({ error: "Failed to load sync status." });
  }
});

// Manual "sync now" trigger for the Buildium-backed metric cache tiles.
// Synchronous (awaits the refresh before responding) — the cache refresh
// this covers is small enough (delinquency summary + property count) that
// a background job isn't warranted yet; if that changes, this becomes a
// fire-and-forget with the sync log row as the only way to check progress.
syncRoutes.post("/api/sync/now", async (_req, res) => {
  const syncLogId = await startSyncRun("buildium", "metric_cache_refresh");
  try {
    const [balances, properties] = await Promise.all([fetchOutstandingBalances(), fetchProperties()]);
    const delinquency = summarizeDelinquency(balances);

    await upsertCachedMetric("delinquency_summary", "portfolio", "buildium", delinquency);
    await upsertCachedMetric("property_count", "portfolio", "buildium", { count: properties.length });

    await completeSyncRun(syncLogId, properties.length + balances.length);
    logInfo("Manual sync completed", { syncLogId });
    res.json({ ok: true, syncedAt: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordCacheRefreshFailure("delinquency_summary", "portfolio", "buildium", message);
    await failSyncRun(syncLogId, message);
    logError("Manual sync failed", { syncLogId, error: message });
    res.status(502).json({ error: "Sync failed. Last known-good data is still being served.", detail: message });
  }
});
