import { describe, it, expect } from "vitest";
import { isScheduledRunTime } from "../../src/lib/scheduler.js";

// Regression coverage for the 2026-07-17 production incident: crontab's
// CRON_TZ=America/New_York was silently not honored by the cron
// implementation on the VPS, so jobs meant for 10:00/10:15/10:30 ET fired
// at 10:00/10:15/10:30 UTC instead (4 hours early during EDT). The fix
// moves "is it actually the right local time?" into the application, so it
// no longer depends on cron's timezone handling at all — this locks in
// that the check is DST-correct in both directions.
describe("isScheduledRunTime — DST-safe local-time gate for cron ticks", () => {
  it("matches exactly at 10:00am Eastern during EDT (summer) — 14:00 UTC", () => {
    // 2026-07-15 14:00 UTC = 10:00am EDT (UTC-4)
    expect(isScheduledRunTime(new Date("2026-07-15T14:00:00Z"), 10, 0)).toBe(true);
  });

  it("does NOT match 10:00 UTC during EDT — this is exactly the bug that fired 4 hours early", () => {
    expect(isScheduledRunTime(new Date("2026-07-15T10:00:00Z"), 10, 0)).toBe(false);
  });

  it("matches exactly at 10:00am Eastern during EST (winter) — 15:00 UTC", () => {
    // 2026-01-15 15:00 UTC = 10:00am EST (UTC-5)
    expect(isScheduledRunTime(new Date("2026-01-15T15:00:00Z"), 10, 0)).toBe(true);
  });

  it("does NOT match 14:00 UTC during EST (would be 9:00am local, not 10:00am)", () => {
    expect(isScheduledRunTime(new Date("2026-01-15T14:00:00Z"), 10, 0)).toBe(false);
  });

  it("matches 10:15am and 10:30am Eastern targets independently in the same summer instant window", () => {
    expect(isScheduledRunTime(new Date("2026-07-15T14:15:00Z"), 10, 15)).toBe(true);
    expect(isScheduledRunTime(new Date("2026-07-15T14:30:00Z"), 10, 30)).toBe(true);
    expect(isScheduledRunTime(new Date("2026-07-15T14:15:00Z"), 10, 30)).toBe(false);
  });

  it("a 15-minutely UTC cron grid always lines up exactly with 10:00/10:15/10:30 ET, spring and fall", () => {
    // Spring forward: 2026-03-08. After 2am local, EDT (-4) is in effect.
    // 10:00am EDT that day = 14:00 UTC, which IS on the */15 UTC grid.
    expect(isScheduledRunTime(new Date("2026-03-08T14:00:00Z"), 10, 0)).toBe(true);
    // Fall back: 2026-11-01. After 2am local, EST (-5) is in effect.
    // 10:00am EST that day = 15:00 UTC, also on the */15 UTC grid.
    expect(isScheduledRunTime(new Date("2026-11-01T15:00:00Z"), 10, 0)).toBe(true);
  });

  it("does not match a nearby but wrong minute (e.g. 10:05) — cron ticks that aren't the target are true no-ops", () => {
    expect(isScheduledRunTime(new Date("2026-07-15T14:05:00Z"), 10, 0)).toBe(false);
  });
});
