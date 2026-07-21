import { describe, expect, it } from "vitest";
import { isScheduledRunTime, computeScheduledRunTime } from "../../src/lib/scheduler.js";

describe("isScheduledRunTime", () => {
  it("matches 3:00am Eastern in winter (EST, UTC-5)", () => {
    // 2026-01-15 08:00 UTC = 3:00am EST
    const now = new Date("2026-01-15T08:00:00Z");
    expect(isScheduledRunTime(now, 3, 0)).toBe(true);
  });

  it("matches 3:00am Eastern in summer (EDT, UTC-4)", () => {
    // 2026-07-15 07:00 UTC = 3:00am EDT
    const now = new Date("2026-07-15T07:00:00Z");
    expect(isScheduledRunTime(now, 3, 0)).toBe(true);
  });

  it("does not match a different hour/minute", () => {
    const now = new Date("2026-07-15T12:00:00Z");
    expect(isScheduledRunTime(now, 3, 0)).toBe(false);
  });
});

describe("computeScheduledRunTime", () => {
  it("resolves to the correct UTC instant for a summer (EDT) run", () => {
    const now = new Date("2026-07-15T07:00:00Z");
    const scheduled = computeScheduledRunTime(now, 3);
    expect(scheduled.toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });

  it("resolves to the correct UTC instant for a winter (EST) run", () => {
    const now = new Date("2026-01-15T08:00:00Z");
    const scheduled = computeScheduledRunTime(now, 3);
    expect(scheduled.toISOString()).toBe("2026-01-15T08:00:00.000Z");
  });
});
