import type { Pool } from "pg";
import { loadEnv } from "../config/env.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace } from "../lib/trace.js";
import { logError, logInfo } from "../lib/appLogger.js";
import { sendAlert } from "../email/sendAlert.js";

// Marks an error as already handled (job_runs row written, alert already
// sent) before re-throwing, so runJobEntryPoint's outer fallback catch
// (which exists for crashes that happen BEFORE this function gets to write
// anything) can tell the difference and not send a second, incorrect alert
// claiming the failure was never recorded when it actually was.
export const ALREADY_ALERTED = Symbol("alreadyAlerted");

// Wraps any job function with job_runs tracking + immediate, business-day-
// aware failure alerting to Jason. A daily legal deadline (the 14-day
// clock) must never slip silently because of an unhandled exception.
export async function runTrackedJob<T>(
  jobPool: Pool,
  jobName: string,
  scheduledFor: Date,
  fn: () => Promise<T>
): Promise<T> {
  const trace = startTrace();
  const env = loadEnv();

  const runRow = await jobPool.query<{ id: number }>(
    `INSERT INTO job_runs (job_name, scheduled_for, started_at, status, trace_id)
     VALUES ($1, $2, now(), 'running', $3) RETURNING id`,
    [jobName, scheduledFor, trace.trace_id]
  );
  const jobRunId = runRow.rows[0].id;

  try {
    const result = await fn();
    const stats = (result ?? {}) as Record<string, unknown>;
    await jobPool.query(
      `UPDATE job_runs SET status = 'succeeded', completed_at = now(),
         leases_checked = $1, notices_drafted = $2
       WHERE id = $3`,
      [
        typeof stats.leasesChecked === "number" ? stats.leasesChecked : null,
        typeof stats.noticesDrafted === "number" ? stats.noticesDrafted : null,
        jobRunId,
      ]
    );
    logInfo(`job ${jobName} succeeded`, { jobName, traceId: trace.trace_id });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await jobPool.query(
      `UPDATE job_runs SET status = 'failed', completed_at = now(), error_message = $1 WHERE id = $2`,
      [message, jobRunId]
    );
    logError(`job ${jobName} failed`, { jobName, traceId: trace.trace_id, error: message });

    await writeAuditLog(jobPool, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      actorType: "system",
      actorId: jobName,
      eventType: "job.failed",
      eventSummary: `Job "${jobName}" failed: ${message}`,
      eventData: { jobRunId },
      contextSnapshot: { jobName, scheduledFor: scheduledFor.toISOString() },
      privacyCategory: "N/A",
      regulationTags: [],
      riskLevel: "critical",
      legalBasis: "operational_integrity",
      retentionPolicy: "retain_7_years_post_tenancy",
      trace,
    });

    // The alert attempt must never mask the ORIGINAL job error — if Teams
    // itself is unreachable, that's a second, separate problem. Catch it
    // here so a failed alert can't replace the real failure with a
    // confusing "webhook returned 500" error instead of the Buildium/DB
    // issue that actually broke the job.
    try {
      await sendAlert({
        to: env.JASON_ALERT_EMAIL,
        subject: `URGENT: ${jobName} failed — late rent notice job did not complete`,
        body:
          `The "${jobName}" job failed at ${new Date().toISOString()}.\n\n` +
          `Error: ${message}\n\n` +
          `This may mean a legal notice deadline is at risk. Check job_runs (id=${jobRunId}) ` +
          `and audit_log for details, then re-run the job manually once the underlying issue is fixed.`,
      });
      await jobPool.query("UPDATE job_runs SET jason_alerted_at = now() WHERE id = $1", [jobRunId]);
    } catch (alertErr) {
      logError(`job ${jobName} failed AND the alert about it also failed to deliver`, {
        jobName,
        traceId: trace.trace_id,
        error: alertErr instanceof Error ? alertErr.message : String(alertErr),
      });
      // job_runs.jason_alerted_at stays null in this case — that null is
      // itself the signal that the alert never reached anyone, distinct
      // from a successful alert. No infra-level watcher exists yet to
      // catch "alert delivery itself is broken" — flagged for Scotty.
    }

    if (err instanceof Error) {
      (err as Error & { [ALREADY_ALERTED]?: true })[ALREADY_ALERTED] = true;
    }
    throw err;
  }
}
