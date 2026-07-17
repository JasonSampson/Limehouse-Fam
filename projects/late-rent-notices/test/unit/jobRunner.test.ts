import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../../src/config/env.js";

// Regression coverage for the 2026-07-17 production incident: 8 leases
// failed inside runDailyLatenessCheck (no active letter_templates row), the
// job's own try/catch swallowed each failure into `errors: string[]`, and
// runTrackedJob wrote status='succeeded', error_message=null — nobody was
// ever told. This locks in the fix: a "succeeded" run with a non-empty
// `errors` array on its result must (1) write a non-null error_message to
// job_runs, and (2) alert Jason via the same sendAlert() mechanism already
// used for real job failures / unassignedPropertyIssues, not a second one.
vi.mock("../../src/config/env.js", () => ({
  loadEnv: vi.fn(),
}));
vi.mock("../../src/lib/appLogger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../../src/lib/auditLog.js", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/email/sendAlert.js", () => ({
  sendAlert: vi.fn().mockResolvedValue(undefined),
}));

import { loadEnv } from "../../src/config/env.js";
import { sendAlert } from "../../src/email/sendAlert.js";
import { runTrackedJob } from "../../src/jobs/jobRunner.js";

const loadEnvMock = vi.mocked(loadEnv);
const sendAlertMock = vi.mocked(sendAlert);

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SHADOW_MODE: true,
    JASON_ALERT_EMAIL: "jason@limehousepm.com",
    TEAMS_ALERT_WEBHOOK_URL: "https://outlook.office.com/webhook/fake-webhook-url",
    ...overrides,
  } as Env;
}

// Minimal fake pg Pool: records every query + params, returns a fixed
// job_runs id for the initial INSERT, and an empty rows array otherwise
// (none of the UPDATE queries here read RETURNING data back).
function fakePool() {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const query = vi.fn(async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    if (text.includes("INSERT INTO job_runs")) {
      return { rows: [{ id: 42 }] };
    }
    return { rows: [] };
  });
  return { query, calls } as unknown as { query: typeof query; calls: typeof calls };
}

describe("runTrackedJob — per-item errors on an otherwise-successful run", () => {
  beforeEach(() => {
    loadEnvMock.mockReturnValue(fakeEnv());
    sendAlertMock.mockClear();
  });

  it("a run with an empty errors array still writes error_message = null (no false alarm)", async () => {
    const pool = fakePool();
    await runTrackedJob(pool as never, "daily_lateness_check", new Date(), async () => ({
      leasesChecked: 10,
      noticesDrafted: 3,
      errors: [] as string[],
    }));

    const update = pool.calls.find((c) => c.text.includes("UPDATE job_runs SET status = 'succeeded'"));
    expect(update?.params).toEqual([10, 3, null, 42]);
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it("a run with per-item errors writes a non-null error_message instead of silently succeeding", async () => {
    const pool = fakePool();
    await runTrackedJob(pool as never, "daily_lateness_check", new Date(), async () => ({
      leasesChecked: 8,
      noticesDrafted: 0,
      errors: [
        "Lease (buildium id L-1): No active letter_templates row found — cannot draft notices.",
        "Lease (buildium id L-2): No active letter_templates row found — cannot draft notices.",
      ],
    }));

    const update = pool.calls.find((c) => c.text.includes("UPDATE job_runs SET status = 'succeeded'"));
    const errorMessage = update?.params?.[2] as string;
    expect(errorMessage).toBeTruthy();
    expect(errorMessage).toContain("2 item(s) failed to process");
    expect(errorMessage).toContain("L-1");
    expect(errorMessage).toContain("L-2");
  });

  it("a run with per-item errors alerts Jason via sendAlert (the same mechanism used for hard failures)", async () => {
    const pool = fakePool();
    await runTrackedJob(pool as never, "daily_lateness_check", new Date(), async () => ({
      leasesChecked: 8,
      noticesDrafted: 0,
      errors: ["Lease (buildium id L-1): No active letter_templates row found."],
    }));

    expect(sendAlertMock).toHaveBeenCalledTimes(1);
    const alert = sendAlertMock.mock.calls[0][0];
    expect(alert.subject).toContain("1 item(s) that failed to process");
    expect(alert.body).toContain("L-1");
  });

  it("marks jason_alerted_at once the alert succeeds", async () => {
    const pool = fakePool();
    await runTrackedJob(pool as never, "daily_lateness_check", new Date(), async () => ({
      leasesChecked: 1,
      noticesDrafted: 0,
      errors: ["boom"],
    }));

    const alertedUpdate = pool.calls.find((c) => c.text.includes("jason_alerted_at = now()"));
    expect(alertedUpdate?.params).toEqual([42]);
  });

  it("a very long errors list gets truncated so job_runs.error_message stays bounded", async () => {
    const pool = fakePool();
    const manyErrors = Array.from({ length: 500 }, (_, i) => `Lease ${i}: some long descriptive failure message here`);
    await runTrackedJob(pool as never, "daily_lateness_check", new Date(), async () => ({
      leasesChecked: 500,
      noticesDrafted: 0,
      errors: manyErrors,
    }));

    const update = pool.calls.find((c) => c.text.includes("UPDATE job_runs SET status = 'succeeded'"));
    const errorMessage = update?.params?.[2] as string;
    expect(errorMessage.length).toBeLessThan(4200);
    expect(errorMessage).toContain("truncated");
    expect(errorMessage).toContain("500 total");
  });

  it("still throws and records status='failed' for a real thrown error, unaffected by the new errors-array handling", async () => {
    const pool = fakePool();
    await expect(
      runTrackedJob(pool as never, "daily_lateness_check", new Date(), async () => {
        throw new Error("DB connection lost");
      })
    ).rejects.toThrow("DB connection lost");

    const failedUpdate = pool.calls.find((c) => c.text.includes("status = 'failed'"));
    expect(failedUpdate?.params).toEqual(["DB connection lost", 42]);
  });
});
