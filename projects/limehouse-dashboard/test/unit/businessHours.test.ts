import { describe, it, expect } from "vitest";
import { businessHoursBetween } from "../../src/kpi/businessHours.js";

describe("businessHoursBetween", () => {
  it("counts a same-day span entirely inside business hours", () => {
    // 2026-07-13 is a Monday. 10:00 AM - 2:00 PM EDT = 4 hours.
    expect(businessHoursBetween("2026-07-13T14:00:00Z", "2026-07-13T18:00:00Z")).toBeCloseTo(4, 5);
  });

  it("clips to the 9am-5pm window on both ends", () => {
    // 2026-07-13 Monday 7:00 AM EDT to 8:00 PM EDT -> only 9am-5pm counts = 8 hours.
    expect(businessHoursBetween("2026-07-13T11:00:00Z", "2026-07-14T00:00:00Z")).toBeCloseTo(8, 5);
  });

  it("skips weekends entirely", () => {
    // Friday 2026-07-10 4:00 PM EDT to Monday 2026-07-13 10:00 AM EDT.
    // Friday: 4pm-5pm = 1h. Sat/Sun: 0. Monday: 9am-10am = 1h. Total = 2h.
    expect(businessHoursBetween("2026-07-10T20:00:00Z", "2026-07-13T14:00:00Z")).toBeCloseTo(2, 5);
  });

  it("skips a US federal holiday (Independence Day, observed)", () => {
    // 2026-07-04 is a Saturday -> observed Friday 2026-07-03. Thursday
    // 2026-07-02 4pm EDT to Monday 2026-07-06 10am EDT: Thu 1h + Fri 0
    // (holiday) + weekend 0 + Mon 1h = 2h.
    expect(businessHoursBetween("2026-07-02T20:00:00Z", "2026-07-06T14:00:00Z")).toBeCloseTo(2, 5);
  });

  it("returns 0 when end is before or equal to start", () => {
    expect(businessHoursBetween("2026-07-13T14:00:00Z", "2026-07-13T14:00:00Z")).toBe(0);
    expect(businessHoursBetween("2026-07-13T18:00:00Z", "2026-07-13T14:00:00Z")).toBe(0);
  });

  it("correctly spans the EST/EDT transition (November)", () => {
    // 2026-11-01 is EDT (UTC-4), 2026-11-08 is EST (UTC-5) after the
    // Nov 1, 2026 2am fallback. Both are Sundays this year, so use two
    // weekdays that straddle the transition: Fri 2026-10-30 (EDT) and
    // Mon 2026-11-02 (EST, since the transition is Sun Nov 1 2am).
    // Fri 4pm EDT (20:00Z) - 5pm EDT (21:00Z) = 1h. Mon 9am EST (14:00Z)
    // - 10am EST (15:00Z) = 1h. Total = 2h across the transition.
    expect(businessHoursBetween("2026-10-30T20:00:00Z", "2026-11-02T15:00:00Z")).toBeCloseTo(2, 5);
  });
});

describe("businessHoursBetween — federal holiday observed-date shifting", () => {
  it("shifts New Year's Day 2027 (Friday) — no shift needed, falls on a weekday already", () => {
    // Jan 1, 2027 is a Friday -> holiday as-is. Dec 31, 2026 (Thu) 4pm EST
    // to Jan 4, 2027 (Mon) 10am EST: Thu 1h + Fri(holiday) 0 + weekend 0 + Mon 1h = 2h.
    expect(businessHoursBetween("2026-12-31T21:00:00Z", "2027-01-04T15:00:00Z")).toBeCloseTo(2, 5);
  });
});
