import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression coverage for Jason's 2026-08-07 request: opening the Late Rent
// Notices dashboard should kick off an extra daily_lateness_check run when
// it's been a while, without flooding Buildium if staff are in and out of
// the page all day. Locks in: the 15-minute throttle, and that this feature
// can never itself break the page (spawn errors are swallowed, not thrown).
const { fakeChild, spawnMock } = vi.hoisted(() => {
  const fakeChild = { on: vi.fn(), unref: vi.fn() };
  return { fakeChild, spawnMock: vi.fn(() => fakeChild) };
});
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../../src/lib/appLogger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

import { maybeTriggerOnDemandLatenessCheck } from "../../src/lib/onDemandLatenessTrigger.js";

function fakePool(lastRunStartedAt: string | null) {
  const query = vi.fn(async () => ({
    rows: lastRunStartedAt ? [{ started_at: lastRunStartedAt }] : [],
  }));
  return { query } as unknown as import("pg").Pool;
}

describe("maybeTriggerOnDemandLatenessCheck", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    fakeChild.on.mockClear();
    fakeChild.unref.mockClear();
  });

  it("spawns the job when it has never run before", async () => {
    await maybeTriggerOnDemandLatenessCheck(fakePool(null));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1]).toEqual(["run", "job:daily", "--", "--force"]);
  });

  it("does NOT spawn again if the last run was 5 minutes ago (inside the 15-minute throttle)", async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await maybeTriggerOnDemandLatenessCheck(fakePool(fiveMinAgo));
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns again once the last run is more than 15 minutes old", async () => {
    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await maybeTriggerOnDemandLatenessCheck(fakePool(twentyMinAgo));
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("never throws if the throttle check itself fails — a broken convenience feature must not break the page", async () => {
    const brokenPool = { query: vi.fn().mockRejectedValue(new Error("db down")) } as unknown as import("pg").Pool;
    await expect(maybeTriggerOnDemandLatenessCheck(brokenPool)).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("unrefs the spawned child so it can't keep the web server process alive", async () => {
    await maybeTriggerOnDemandLatenessCheck(fakePool(null));
    expect(fakeChild.unref).toHaveBeenCalledTimes(1);
  });
});
