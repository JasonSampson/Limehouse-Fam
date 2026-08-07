import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { getAppPool } from "../db/pool.js";
import { logInfo, logError } from "./appLogger.js";

// Jason's request (2026-08-07): staff already get an email from Buildium the
// moment a payment bounces, so by the time someone opens Late Rent Notices
// they're usually there to act on something that just happened — not to wait
// for the next 10:00/10:15/10:30 scheduled check. This lets a page visit
// kick off an extra daily_lateness_check run, without staff having to know
// that job exists or trigger it themselves.
//
// Throttled to once per 15 minutes (confirmed with Jason) so a busy staff
// day full of page visits doesn't turn into a flood of Buildium calls or
// overlapping runs — matches the same 15-minute cadence the scheduled checks
// already use.
const THROTTLE_MS = 15 * 60 * 1000;

// job_runs has no RLS (migration 0016 never enabled it there) and carries no
// tenant/PM-scoped data — it's operational history, same category as the
// pm_users lookup authRoutes.ts already does directly against getAppPool()
// before any PM session/scope exists. Querying it straight, without
// withPmScope, doesn't touch the RLS boundary that rule protects.
async function msSinceLastRun(pool: Pool): Promise<number | null> {
  const result = await pool.query<{ started_at: string }>(
    `SELECT started_at FROM job_runs WHERE job_name = 'daily_lateness_check' ORDER BY started_at DESC LIMIT 1`
  );
  const lastRun = result.rows[0];
  if (!lastRun) return null;
  return Date.now() - new Date(lastRun.started_at).getTime();
}

// The web server (late_rent_app, RLS-subject) must never call jobPool
// directly (see db/pool.ts) — daily_lateness_check needs jobPool to see
// every lease company-wide. So instead of importing and running that job
// in-process, this spawns the exact same script cron already runs
// (`npm run job:daily`), detached, and returns immediately. Any failure
// inside that run is caught and alerted by the job's own runTrackedJob/
// runJobEntryPoint machinery exactly as it would be at 10am — this function
// only decides whether to start it, never waits to find out how it went.
function spawnOnDemandCheck(): void {
  const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  const child = spawn(npmCommand, ["run", "job:daily", "--", "--force"], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    // Windows resolves "npm" to npm.cmd, and Node refuses to spawn .cmd/.bat
    // files without shell:true (throws EINVAL instead) — see nodejs.org/api/
    // child_process.html#spawning-bat-and-cmd-files-on-windows. The args
    // above are fixed literals, never user input, so shell interpretation of
    // them isn't a risk.
    shell: process.platform === "win32",
  });
  child.on("error", (err) => {
    logError("on-demand daily_lateness_check failed to start", { error: err.message });
  });
  child.unref();
}

// Called from the notices list endpoint — fire-and-forget, never awaited by
// the request, and any error here is logged, never thrown, so a hiccup in
// this convenience feature can never break the page staff actually need.
export async function maybeTriggerOnDemandLatenessCheck(pool: Pool = getAppPool()): Promise<void> {
  try {
    const elapsedMs = await msSinceLastRun(pool);
    if (elapsedMs !== null && elapsedMs < THROTTLE_MS) {
      return;
    }
    logInfo("triggering on-demand daily_lateness_check from a page visit", {
      minutesSinceLastRun: elapsedMs === null ? null : Math.round(elapsedMs / 60000),
    });
    spawnOnDemandCheck();
  } catch (err) {
    logError("maybeTriggerOnDemandLatenessCheck failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
