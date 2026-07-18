import {
  refreshRentCollectionCache,
  refreshSecurityDepositWithheldCache,
  refreshRenewalRateCache,
  refreshCallActivityCache,
  refreshRentEngineLeasingPerformanceCache,
} from "./cacheRefreshJobs.js";
import { logError } from "../lib/logger.js";

// In-app scheduler — ADDED 2026-07-18, per Jason directly (relayed from the
// LimeHQ project's investigation of "Not connected"/"Couldn't load" tiles
// and 60+ second loads). Deliberately NOT a server crontab entry: this ships
// as an ordinary code change to this repo, starts itself the moment the app
// runs, and needs no separate manual step on the production server — same
// long-running-process assumption late-rent-notices' cron jobs already
// depend on (PM2 keeps this process alive), just without needing an actual
// crontab line here too.
//
// Each job is wrapped so one failing or running long never blocks or
// crashes another — setInterval schedules the next tick regardless of
// whether the previous run is still in flight or threw. Real failures are
// still recorded to dashboard_metric_cache's last_error column by the job
// functions themselves (see cacheRefreshJobs.ts) — this catch is only a
// last-resort net so a bug in that recording path can't take the process
// down.
function runSafely(name: string, fn: () => Promise<void>): void {
  fn().catch((err) => {
    logError(`Scheduled job "${name}" threw unexpectedly`, { error: err instanceof Error ? err.message : String(err) });
  });
}

interface ScheduledJob {
  name: string;
  fn: () => Promise<void>;
  intervalMs: number;
  // Stagger the first run so a fresh deploy/restart doesn't fire every job
  // at Buildium/RentEngine at once.
  initialDelayMs: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Intervals per Jason's approved plan (2026-07-18):
//   - RentEngine leasing-performance: every 8 min, just inside its own
//     10-minute cache TTL, so it's never caught stale.
//   - Renewal Rate / Rent Collection / Call Activity: every 2 hours —
//     portfolio-level financial/leasing metrics that don't shift minute to
//     minute, and Call Activity specifically must NOT run tighter than this
//     given RentEngine's per-prospect rate-limit cost (see
//     callActivitySync.ts).
//   - Security Deposit Withheld: every 4 hours — the slowest-moving of the
//     five.
//   - terminated-properties / financial-history / team-performance-kpis are
//     deliberately NOT scheduled here — unconfirmed as user-facing tiles
//     (per the investigation), left manual-only until a real tile is found
//     depending on one going stale.
const JOBS: ScheduledJob[] = [
  { name: "rentengine-leasing-performance", fn: refreshRentEngineLeasingPerformanceCache, intervalMs: 8 * MINUTE, initialDelayMs: 0 },
  { name: "renewal-rate", fn: refreshRenewalRateCache, intervalMs: 2 * HOUR, initialDelayMs: 15 * 1000 },
  { name: "rent-collection", fn: refreshRentCollectionCache, intervalMs: 2 * HOUR, initialDelayMs: 30 * 1000 },
  { name: "call-activity", fn: refreshCallActivityCache, intervalMs: 2 * HOUR, initialDelayMs: 45 * 1000 },
  { name: "security-deposit-withheld", fn: refreshSecurityDepositWithheldCache, intervalMs: 4 * HOUR, initialDelayMs: 60 * 1000 },
];

let started = false;

export function startScheduledCacheRefresh(): void {
  if (started) return; // idempotent — a second call (e.g. from a test importing server.ts twice) is a no-op, not double-scheduled jobs.
  started = true;

  for (const job of JOBS) {
    setTimeout(() => {
      runSafely(job.name, job.fn);
      setInterval(() => runSafely(job.name, job.fn), job.intervalMs);
    }, job.initialDelayMs);
  }
}
