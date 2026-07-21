import type { Pool } from "pg";
import { loadEnv } from "../config/env.js";
import { startTrace } from "../lib/trace.js";
import { logError, logInfo } from "../lib/appLogger.js";
import { sendAlert } from "../email/sendAlert.js";

// sync_runs equivalent of late-rent-notices' job_runs + jobRunner.ts
// (runTrackedJob). Same core guarantee (spec Risk #2 / commit bfc5a73):
// a sync step that finishes without throwing can still have left
// individual items unprocessed (one property's geocode failed, one
// photo download failed) — that must show up as a real, populated
// sync_runs.error_message and a real alert to Jason, not just a server
// log line nobody reads.
export const ALREADY_ALERTED = Symbol("alreadyAlerted");

export interface SyncStepCounts {
  properties_synced?: number;
  units_synced?: number;
  leases_synced?: number;
  photos_synced?: number;
  public_locations_synced?: number;
}

export interface SyncStepResult {
  counts?: SyncStepCounts;
  errors?: string[];
  // Set false only for a KNOWN, DOCUMENTED gap (currently: RentEngine sync
  // running with no credentials configured yet) — populates error_message
  // so the gap stays visible in sync_runs, but does not page Jason about
  // something he already knows is unbuilt. Any other step's errors always
  // alert (default true).
  alertOnErrors?: boolean;
}

const MAX_ERROR_MESSAGE_LENGTH = 4000;

function truncateErrorMessage(full: string): string {
  return full.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${full.slice(0, MAX_ERROR_MESSAGE_LENGTH)}\n... (truncated)`
    : full;
}

export async function runTrackedSyncStep(
  jobPool: Pool,
  jobName: string,
  scheduledFor: Date,
  fn: () => Promise<SyncStepResult>
): Promise<SyncStepResult> {
  const trace = startTrace();
  const env = loadEnv();

  const runRow = await jobPool.query<{ id: number }>(
    `INSERT INTO sync_runs (job_name, scheduled_for, started_at, status, trace_id)
     VALUES ($1, $2, now(), 'running', $3) RETURNING id`,
    [jobName, scheduledFor, trace.trace_id]
  );
  const syncRunId = runRow.rows[0].id;

  try {
    const result = await fn();
    const counts = result.counts ?? {};
    const errors = result.errors ?? [];
    const alertOnErrors = result.alertOnErrors ?? true;

    let errorMessage: string | null = null;
    if (errors.length > 0) {
      const summary = `${errors.length} item(s) reported during this run.`;
      errorMessage = truncateErrorMessage(`${summary}\n${errors.join("\n")}`);
    }

    await jobPool.query(
      `UPDATE sync_runs SET status = 'succeeded', completed_at = now(),
         properties_synced = $1, units_synced = $2, leases_synced = $3,
         photos_synced = $4, public_locations_synced = $5, error_message = $6
       WHERE id = $7`,
      [
        counts.properties_synced ?? null,
        counts.units_synced ?? null,
        counts.leases_synced ?? null,
        counts.photos_synced ?? null,
        counts.public_locations_synced ?? null,
        errorMessage,
        syncRunId,
      ]
    );
    logInfo(`sync step ${jobName} succeeded`, {
      jobName,
      traceId: trace.trace_id,
      ...(errors.length > 0 ? { itemErrorCount: errors.length } : {}),
    });

    if (errors.length > 0 && alertOnErrors) {
      try {
        await sendAlert({
          to: env.JASON_ALERT_EMAIL,
          subject: `ACTION NEEDED: Map sync step "${jobName}" completed with ${errors.length} item(s) that failed`,
          body:
            `The "${jobName}" Map sync step finished, but ${errors.length} item(s) failed to process:\n\n` +
            errors.map((e) => `- ${e}`).join("\n") +
            `\n\nCheck sync_runs (id=${syncRunId}) for details. Nothing else in this run was necessarily affected.`,
        });
        await jobPool.query("UPDATE sync_runs SET jason_alerted_at = now() WHERE id = $1", [syncRunId]);
      } catch (alertErr) {
        logError(`sync step ${jobName} had item errors AND the alert about it also failed to deliver`, {
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
      `UPDATE sync_runs SET status = 'failed', completed_at = now(), error_message = $1 WHERE id = $2`,
      [message, syncRunId]
    );
    logError(`sync step ${jobName} failed`, { jobName, traceId: trace.trace_id, error: message });

    try {
      await sendAlert({
        to: env.JASON_ALERT_EMAIL,
        subject: `URGENT: Map sync step "${jobName}" failed`,
        body:
          `The "${jobName}" Map sync step failed at ${new Date().toISOString()}.\n\n` +
          `Error: ${message}\n\n` +
          `Check sync_runs (id=${syncRunId}) for details, then re-run the sync manually once the underlying ` +
          `issue is fixed. This step's data may now be stale until the next successful run.`,
      });
      await jobPool.query("UPDATE sync_runs SET jason_alerted_at = now() WHERE id = $1", [syncRunId]);
    } catch (alertErr) {
      logError(`sync step ${jobName} failed AND the alert about it also failed to deliver`, {
        jobName,
        traceId: trace.trace_id,
        error: alertErr instanceof Error ? alertErr.message : String(alertErr),
      });
    }

    if (err instanceof Error) {
      (err as Error & { [ALREADY_ALERTED]?: true })[ALREADY_ALERTED] = true;
    }
    throw err;
  }
}
