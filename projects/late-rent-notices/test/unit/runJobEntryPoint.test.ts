import { describe, it, expect, vi, beforeEach } from "vitest";

// Coverage for the `force` option added 2026-08-07: onDemandLatenessTrigger.ts
// spawns this same entry point with --force when a staff member opens the
// dashboard outside the normal 10:00/10:15/10:30 cron ticks. Locks in that
// force bypasses the "is it the scheduled minute" gate without touching the
// normal scheduled-run behavior at all.
const { isScheduledRunTimeMock, computeScheduledRunTimeMock } = vi.hoisted(() => ({
  isScheduledRunTimeMock: vi.fn(),
  computeScheduledRunTimeMock: vi.fn(() => new Date("2026-08-07T14:00:00Z")),
}));
vi.mock("../../src/lib/scheduler.js", () => ({
  isScheduledRunTime: isScheduledRunTimeMock,
  computeScheduledRunTime: computeScheduledRunTimeMock,
}));

const { runTrackedJobMock } = vi.hoisted(() => ({
  runTrackedJobMock: vi.fn(async (_pool: unknown, _name: unknown, _scheduledFor: unknown, fn: () => unknown) => fn()),
}));
vi.mock("../../src/jobs/jobRunner.js", () => ({
  runTrackedJob: runTrackedJobMock,
  ALREADY_ALERTED: Symbol("alreadyAlerted"),
}));

vi.mock("../../src/db/pool.js", () => ({
  getJobPool: vi.fn(() => ({})),
  closePools: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/email/sendAlert.js", () => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/config/env.js", () => ({ loadEnv: vi.fn(() => ({ JASON_ALERT_EMAIL: "jason@limehousepm.com" })) }));
vi.mock("../../src/lib/appLogger.js", () => ({ logInfo: vi.fn(), logError: vi.fn() }));

import { runJobEntryPoint } from "../../src/jobs/runJobEntryPoint.js";

describe("runJobEntryPoint force option", () => {
  beforeEach(() => {
    isScheduledRunTimeMock.mockClear();
    computeScheduledRunTimeMock.mockClear();
    runTrackedJobMock.mockClear();
  });

  it("skips the run when it's not the scheduled tick and force is not set (existing behavior)", async () => {
    isScheduledRunTimeMock.mockReturnValue(false);
    const runFn = vi.fn();
    await runJobEntryPoint("daily_lateness_check", 10, 0, runFn);
    expect(runTrackedJobMock).not.toHaveBeenCalled();
    expect(runFn).not.toHaveBeenCalled();
  });

  it("runs anyway when force is true, even outside the scheduled tick", async () => {
    isScheduledRunTimeMock.mockReturnValue(false);
    const runFn = vi.fn().mockResolvedValue(undefined);
    await runJobEntryPoint("daily_lateness_check", 10, 0, runFn, { force: true });
    expect(runTrackedJobMock).toHaveBeenCalledTimes(1);
  });

  it("stamps scheduled_for as roughly now for a forced run, not the usual 10am slot", async () => {
    isScheduledRunTimeMock.mockReturnValue(false);
    await runJobEntryPoint("daily_lateness_check", 10, 0, vi.fn(), { force: true });
    const scheduledFor = runTrackedJobMock.mock.calls[0][2] as Date;
    expect(computeScheduledRunTimeMock).not.toHaveBeenCalled();
    expect(Math.abs(scheduledFor.getTime() - Date.now())).toBeLessThan(5000);
  });

  it("still runs normally at the actual scheduled tick with no force flag", async () => {
    isScheduledRunTimeMock.mockReturnValue(true);
    await runJobEntryPoint("daily_lateness_check", 10, 0, vi.fn());
    expect(runTrackedJobMock).toHaveBeenCalledTimes(1);
    expect(computeScheduledRunTimeMock).toHaveBeenCalledTimes(1);
  });
});
