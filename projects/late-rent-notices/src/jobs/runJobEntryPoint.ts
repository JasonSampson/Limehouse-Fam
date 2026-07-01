import type { Pool } from "pg";
import { getJobPool, closePools } from "../db/pool.js";
import { runTrackedJob, ALREADY_ALERTED } from "./jobRunner.js";
import { computeScheduledRunTime } from "../lib/scheduler.js";
import { sendAlert } from "../email/sendAlert.js";
import { loadEnv } from "../config/env.js";

// Shared entry point for the three cron-invoked jobs (daily lateness check,
// escalation check, PM reminder check). runTrackedJob already writes a
// job_runs row + sends an alert for failures that occur INSIDE a run it's
// tracking. This wrapper exists for the gap Atlas's review found: a crash
// before runTrackedJob even gets to write that first job_runs row at all
// (bad DATABASE_URL_JOB, a pool that fails to construct, .env partially
// broken) — without this, that failure mode is silent except for a stderr
// line and a non-zero exit code nobody is watching. Best-effort: still try
// to alert Jason directly, bypassing job_runs/audit_log entirely, since
// those may not be reachable in this exact failure mode.
//
// Known residual limit: if loadEnv() itself throws (e.g. JASON_ALERT_EMAIL
// is missing from .env), there is no recipient to alert in-process at all.
// That single edge case is not closable from inside this codebase — it
// needs an infra-level dead-man's-switch (e.g. a cron wrapper that emails
// on ANY non-zero exit code, or a systemd OnFailure= unit) as defense in
// depth. Flagged for Scotty's deployment notes, not silently left uncovered.
export async function runJobEntryPoint(
  jobName: string,
  runFn: (jobPool: Pool) => Promise<unknown>
): Promise<void> {
  try {
    const jobPool = getJobPool();
    const scheduledFor = computeScheduledRunTime(new Date(), 10);
    await runTrackedJob(jobPool, jobName, scheduledFor, () => runFn(jobPool));
  } catch (err) {
    console.error(err);
    process.exitCode = 1;

    // If runTrackedJob already got far enough to write a job_runs row and
    // send its own correct alert, don't send a second, misleading one here.
    if (err instanceof Error && (err as Error & { [ALREADY_ALERTED]?: true })[ALREADY_ALERTED]) {
      return;
    }

    try {
      const env = loadEnv();
      const message = err instanceof Error ? err.message : String(err);
      await sendAlert({
        to: env.JASON_ALERT_EMAIL,
        subject: `URGENT: ${jobName} crashed before it could record itself`,
        body:
          `The "${jobName}" job crashed immediately, before a job_runs row could even be written ` +
          `(this usually means a database connection or configuration problem, not a Buildium/data issue).\n\n` +
          `Error: ${message}\n\n` +
          `This may mean a legal notice deadline is at risk. This failure did NOT get written to ` +
          `job_runs or audit_log — check the server logs directly for the full error.`,
      });
    } catch (alertErr) {
      console.error("Additionally failed to send the fallback startup-crash alert:", alertErr);
    }
  } finally {
    await closePools().catch((closeErr) => console.error("Error closing pools:", closeErr));
  }
}
