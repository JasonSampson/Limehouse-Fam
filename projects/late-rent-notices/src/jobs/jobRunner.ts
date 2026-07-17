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

    // A job that finished without throwing can still have left individual
    // items unprocessed — dailyLatenessCheck.ts collects those into an
    // `errors: string[]` array (e.g. "no active letter_templates row") and
    // used to just log them via appLogger, which nobody but a server-log
    // reader would ever see. status='succeeded' with error_message=null was
    // indistinguishable from a run where nothing went wrong at all. Treat
    // this the same as the unassignedPropertyIssues alert below it: real
    // failures, surfaced to Jason, not just left in a log file.
    const perItemErrors = Array.isArray(stats.errors)
      ? (stats.errors as unknown[]).filter((e): e is string => typeof e === "string")
      : [];

    let errorMessage: string | null = null;
    if (perItemErrors.length > 0) {
      const summary = `${perItemErrors.length} item(s) failed to process — see details below.`;
      const details = perItemErrors.join("\n");
      const full = `${summary}\n${details}`;
      // error_message is a plain `text` column (no declared length limit),
      // but keep the stored value bounded so one pathological run can't
      // bloat job_runs indefinitely — 4000 chars comfortably fits dozens of
      // one-line errors, which is already far more than a human will read.
      const MAX_ERROR_MESSAGE_LENGTH = 4000;
      errorMessage =
        full.length > MAX_ERROR_MESSAGE_LENGTH
          ? `${full.slice(0, MAX_ERROR_MESSAGE_LENGTH)}\n... (truncated, ${perItemErrors.length} total)`
          : full;
    }

    await jobPool.query(
      `UPDATE job_runs SET status = 'succeeded', completed_at = now(),
         leases_checked = $1, notices_drafted = $2, error_message = $3
       WHERE id = $4`,
      [
        typeof stats.leasesChecked === "number" ? stats.leasesChecked : null,
        typeof stats.noticesDrafted === "number" ? stats.noticesDrafted : null,
        errorMessage,
        jobRunId,
      ]
    );
    logInfo(`job ${jobName} succeeded`, {
      jobName,
      traceId: trace.trace_id,
      ...(perItemErrors.length > 0 ? { itemErrorCount: perItemErrors.length } : {}),
    });

    if (perItemErrors.length > 0) {
      // Same alert path used for the unassignedPropertyIssues case in
      // dailyLatenessCheck.ts — reused rather than duplicated, and caught
      // the same way (an alert-delivery failure must never mask the fact
      // that the job itself did complete, just with per-item failures).
      try {
        await sendAlert({
          to: env.JASON_ALERT_EMAIL,
          subject: `ACTION NEEDED: ${jobName} completed with ${perItemErrors.length} item(s) that failed to process`,
          body:
            `The "${jobName}" job finished its run, but ${perItemErrors.length} item(s) inside it failed to ` +
            `process and were skipped:\n\n` +
            perItemErrors.map((e) => `- ${e}`).join("\n") +
            `\n\nCheck job_runs (id=${jobRunId}) and audit_log for details. Nothing else in this run was ` +
            `affected — this alert covers only the item(s) listed above.`,
        });
        await jobPool.query("UPDATE job_runs SET jason_alerted_at = now() WHERE id = $1", [jobRunId]);
      } catch (alertErr) {
        logError(`job ${jobName} succeeded with item errors AND the alert about it also failed to deliver`, {
          jobName,
          traceId: trace.trace_id,
          error: alertErr instanceof Error ? alertErr.message : String(alertErr),
        });
      }
    }

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
