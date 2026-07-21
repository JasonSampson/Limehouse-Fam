#!/usr/bin/env node
// Entry point for Map's daily sync. Intended to be invoked by a cron entry
// on the server (Scotty's deployment job, not built here). Cron should
// fire on a plain UTC schedule (e.g. hourly) — this script itself decides,
// via isScheduledRunTime, whether "now" is actually the intended
// America/New_York run time, for the same DST-safety reason documented in
// late-rent-notices/src/lib/scheduler.ts.
//
// `npm run job:sync:now` (MAP_SYNC_FORCE_RUN=true) bypasses the time check
// for manual/on-demand runs and for TARS's test pass — never set that in
// the real cron entry.
import { getJobPool, closePools } from "../db/pool.js";
import { runDailyMapSync } from "./runDailyMapSync.js";
import { isScheduledRunTime, computeScheduledRunTime } from "../lib/scheduler.js";
import { sendAlert } from "../email/sendAlert.js";
import { loadEnv } from "../config/env.js";
import { logInfo } from "../lib/appLogger.js";

// Daily off-peak run time. Not legally time-sensitive the way late-rent
// notices are (spec: "daily is almost certainly often enough... roughly
// current is entirely acceptable") — 2:00 AM Eastern (Jason's explicit
// choice) keeps it off Buildium and Google's peak hours and out of staff's
// way.
const MAP_SYNC_HOUR_LOCAL = 2;
const MAP_SYNC_MINUTE_LOCAL = 0;

async function main(): Promise<void> {
  const env = loadEnv();
  const now = new Date();

  if (!env.MAP_SYNC_FORCE_RUN && !isScheduledRunTime(now, MAP_SYNC_HOUR_LOCAL, MAP_SYNC_MINUTE_LOCAL)) {
    logInfo("map sync: not the scheduled run time yet, skipping this tick", {});
    return;
  }

  try {
    const jobPool = getJobPool();
    const scheduledFor = env.MAP_SYNC_FORCE_RUN ? now : computeScheduledRunTime(now, MAP_SYNC_HOUR_LOCAL);
    await runDailyMapSync(jobPool, scheduledFor);
  } catch (err) {
    // runDailyMapSync catches and continues past individual step failures
    // itself — reaching here means something crashed BEFORE any step could
    // even be tried (e.g. a bad DATABASE_URL_JOB). Best-effort direct
    // alert, bypassing sync_runs entirely, since it may not be reachable.
    console.error(err);
    process.exitCode = 1;
    try {
      const message = err instanceof Error ? err.message : String(err);
      await sendAlert({
        to: env.JASON_ALERT_EMAIL,
        subject: "URGENT: Map daily sync crashed before any step could run",
        body:
          `The Map daily sync crashed immediately, before any sync_runs row could be written ` +
          `(usually a database connection or configuration problem, not a Buildium/data issue).\n\n` +
          `Error: ${message}\n\nCheck the server logs directly for the full error.`,
      });
    } catch (alertErr) {
      console.error("Additionally failed to send the fallback startup-crash alert:", alertErr);
    }
  } finally {
    await closePools().catch((closeErr) => console.error("Error closing pools:", closeErr));
  }
}

void main();
