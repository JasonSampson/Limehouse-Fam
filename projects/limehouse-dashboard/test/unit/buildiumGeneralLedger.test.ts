import { describe, it, expect } from "vitest";
import { splitIntoMaxRangeWindows } from "../../src/buildium/client.js";

// Buildium's /v1/generalledger enforces a real, confirmed-live 365-day max
// range per request (a wider range returns a real 422: "The time range must
// be less than or equal to 365 days."). splitIntoMaxRangeWindows is what
// fetchGeneralLedgerTotals uses to break a multi-year request (e.g. the
// full 2018-2026 historical backfill) into individual <=365-day calls.
describe("splitIntoMaxRangeWindows", () => {
  it("returns a single window when the range is within 365 days", () => {
    const windows = splitIntoMaxRangeWindows("2026-01-01", "2026-01-31");
    expect(windows).toEqual([{ start: "2026-01-01", end: "2026-01-31" }]);
  });

  it("returns a single window for an exact 365-day range", () => {
    const windows = splitIntoMaxRangeWindows("2026-01-01", "2026-12-31");
    expect(windows).toEqual([{ start: "2026-01-01", end: "2026-12-31" }]);
  });

  it("splits a multi-year range into consecutive <=365-day windows with no gaps or overlaps", () => {
    const windows = splitIntoMaxRangeWindows("2018-01-01", "2019-06-30");
    expect(windows.length).toBeGreaterThan(1);
    for (let i = 1; i < windows.length; i++) {
      const prevEnd = new Date(`${windows[i - 1].end}T00:00:00Z`);
      const thisStart = new Date(`${windows[i].start}T00:00:00Z`);
      const dayAfterPrevEnd = new Date(prevEnd);
      dayAfterPrevEnd.setUTCDate(dayAfterPrevEnd.getUTCDate() + 1);
      expect(thisStart.getTime()).toBe(dayAfterPrevEnd.getTime()); // no gap, no overlap
    }
    expect(windows[0].start).toBe("2018-01-01");
    expect(windows[windows.length - 1].end).toBe("2019-06-30");
  });

  it("covers the full 2018-2026 historical range in multiple valid windows", () => {
    const windows = splitIntoMaxRangeWindows("2018-01-01", "2026-07-05");
    for (const w of windows) {
      const days = (new Date(`${w.end}T00:00:00Z`).getTime() - new Date(`${w.start}T00:00:00Z`).getTime()) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(365);
    }
    expect(windows[0].start).toBe("2018-01-01");
    expect(windows[windows.length - 1].end).toBe("2026-07-05");
  });
});
