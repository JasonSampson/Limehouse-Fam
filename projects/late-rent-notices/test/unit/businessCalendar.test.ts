import { describe, it, expect } from "vitest";
import {
  isFederalHoliday,
  isWeekend,
  isBusinessDay,
  nextBusinessDay,
  rollForwardToBusinessDay,
  addBusinessDays,
  getEasternUtcOffsetHours,
} from "../../src/lib/businessCalendar.js";

describe("isWeekend", () => {
  it("flags Saturday as a weekend", () => {
    // 2026-07-04 is a Saturday
    expect(isWeekend(new Date("2026-07-04T12:00:00Z"))).toBe(true);
  });
  it("flags Sunday as a weekend", () => {
    expect(isWeekend(new Date("2026-07-05T12:00:00Z"))).toBe(true);
  });
  it("does not flag a Wednesday as a weekend", () => {
    expect(isWeekend(new Date("2026-07-01T12:00:00Z"))).toBe(false);
  });
});

describe("isFederalHoliday", () => {
  it("recognizes New Year's Day (fixed date)", () => {
    expect(isFederalHoliday(new Date("2026-01-01T12:00:00Z"))).toBe(true);
  });
  it("recognizes Juneteenth (fixed date)", () => {
    expect(isFederalHoliday(new Date("2026-06-19T12:00:00Z"))).toBe(true);
  });
  it("recognizes Christmas (fixed date)", () => {
    expect(isFederalHoliday(new Date("2026-12-25T12:00:00Z"))).toBe(true);
  });
  it("recognizes Independence Day even though 2026-07-04 also falls on a Saturday this year", () => {
    expect(isFederalHoliday(new Date("2026-07-04T12:00:00Z"))).toBe(true);
    expect(isWeekend(new Date("2026-07-04T12:00:00Z"))).toBe(true);
  });
  it("correctly computes Thanksgiving as the 4th Thursday of November (2026-11-26)", () => {
    expect(isFederalHoliday(new Date("2026-11-26T12:00:00Z"))).toBe(true);
    expect(isFederalHoliday(new Date("2026-11-19T12:00:00Z"))).toBe(false); // 3rd Thursday, not a holiday
  });
  it("correctly computes Memorial Day as the LAST Monday of May, not a fixed nth Monday (2026-05-25)", () => {
    expect(isFederalHoliday(new Date("2026-05-25T12:00:00Z"))).toBe(true);
  });
  it("does not flag an ordinary weekday as a holiday", () => {
    expect(isFederalHoliday(new Date("2026-07-01T12:00:00Z"))).toBe(false);
  });
});

describe("isBusinessDay", () => {
  it("a normal Wednesday is a business day", () => {
    expect(isBusinessDay(new Date("2026-07-01T12:00:00Z"))).toBe(true);
  });
  it("a Saturday is not a business day", () => {
    expect(isBusinessDay(new Date("2026-07-04T12:00:00Z"))).toBe(false);
  });
  it("a weekday federal holiday is not a business day", () => {
    // 2026-12-25 is a Friday
    expect(isBusinessDay(new Date("2026-12-25T12:00:00Z"))).toBe(false);
  });
});

describe("nextBusinessDay / rollForwardToBusinessDay — weekend/holiday extension", () => {
  it("nextBusinessDay rolls a Friday forward past the weekend to Monday", () => {
    // Friday 2026-07-03 -> next business day should be Monday 2026-07-06
    // (note: Sat 7/4 is also July 4th/Independence Day, compounding the gap)
    const result = nextBusinessDay(new Date("2026-07-03T12:00:00Z"));
    expect(result.toISOString().slice(0, 10)).toBe("2026-07-06");
  });

  it("nextBusinessDay always advances at least one day, even starting from a business day", () => {
    const result = nextBusinessDay(new Date("2026-07-01T12:00:00Z")); // Wednesday
    expect(result.toISOString().slice(0, 10)).toBe("2026-07-02");
  });

  it("rollForwardToBusinessDay leaves an already-business day unchanged", () => {
    const input = new Date("2026-07-01T12:00:00Z");
    const result = rollForwardToBusinessDay(input);
    expect(result.toISOString().slice(0, 10)).toBe("2026-07-01");
  });

  it("rollForwardToBusinessDay advances a Saturday to the following Monday", () => {
    const result = rollForwardToBusinessDay(new Date("2026-07-04T12:00:00Z"));
    expect(result.toISOString().slice(0, 10)).toBe("2026-07-06");
  });

  it("rollForwardToBusinessDay skips a holiday landing on a weekday (Christmas 2026, a Friday)", () => {
    const result = rollForwardToBusinessDay(new Date("2026-12-25T12:00:00Z"));
    expect(result.toISOString().slice(0, 10)).toBe("2026-12-28"); // Monday
  });
});

describe("addBusinessDays — the 2-business-day fallback escalation clock", () => {
  it("adds 2 business days from a Wednesday, landing on Friday", () => {
    const result = addBusinessDays(new Date("2026-07-01T12:00:00Z"), 2);
    expect(result.toISOString().slice(0, 10)).toBe("2026-07-03");
  });

  it("adds 2 business days from a Thursday, skipping the weekend to land on Monday", () => {
    // Thursday 2026-07-02 + 2 business days: Fri 7/3, then skip Sat/Sun -> Mon 7/6
    const result = addBusinessDays(new Date("2026-07-02T12:00:00Z"), 2);
    expect(result.toISOString().slice(0, 10)).toBe("2026-07-06");
  });

  it("adds 2 business days starting the Friday before Independence Day weekend, skipping both the weekend AND the holiday", () => {
    // Friday 2026-07-03 -> Sat/Sun/Mon(7/4 observed as Sat, no separate weekday
    // closure this year) — walk it out explicitly: business days after 7/3 are
    // 7/6 (Mon) and 7/7 (Tue), since 7/4 is a Saturday (not a separate weekday
    // closure in 2026).
    const result = addBusinessDays(new Date("2026-07-03T12:00:00Z"), 2);
    expect(result.toISOString().slice(0, 10)).toBe("2026-07-07");
  });

  it("adds 0 business days returns the same day unchanged", () => {
    const start = new Date("2026-07-01T12:00:00Z");
    const result = addBusinessDays(start, 0);
    expect(result.toISOString().slice(0, 10)).toBe("2026-07-01");
  });
});

describe("getEasternUtcOffsetHours — DST handling", () => {
  it("returns -5 (EST) for a date in January (standard time)", () => {
    expect(getEasternUtcOffsetHours(new Date("2026-01-15T12:00:00Z"))).toBe(-5);
  });

  it("returns -4 (EDT) for a date in July (daylight time)", () => {
    expect(getEasternUtcOffsetHours(new Date("2026-07-15T12:00:00Z"))).toBe(-4);
  });

  it("flips from -5 to -4 across the spring-forward boundary (2026-03-08 2:00am local)", () => {
    // 2026 DST starts Sunday March 8 at 2am local (America/New_York).
    // Just before: still EST (-5). Just after: EDT (-4).
    const beforeSpringForward = new Date("2026-03-08T06:59:00Z"); // 1:59am EST
    const afterSpringForward = new Date("2026-03-08T07:01:00Z"); // 3:01am EDT
    expect(getEasternUtcOffsetHours(beforeSpringForward)).toBe(-5);
    expect(getEasternUtcOffsetHours(afterSpringForward)).toBe(-4);
  });

  it("flips from -4 to -5 across the fall-back boundary (2026-11-01 2:00am local)", () => {
    // 2026 DST ends Sunday November 1 at 2am local.
    const beforeFallBack = new Date("2026-11-01T05:59:00Z"); // 1:59am EDT
    const afterFallBack = new Date("2026-11-01T07:01:00Z"); // 2:01am EST
    expect(getEasternUtcOffsetHours(beforeFallBack)).toBe(-4);
    expect(getEasternUtcOffsetHours(afterFallBack)).toBe(-5);
  });

  it("proves the 10am-local scheduling requirement: 10am EDT in July is 14:00 UTC, NOT 15:00 UTC (fixed-EST would be wrong)", () => {
    const julyOffset = getEasternUtcOffsetHours(new Date("2026-07-15T12:00:00Z"));
    const impliedUtcHourFor10amLocal = 10 - julyOffset; // 10 - (-4) = 14
    expect(impliedUtcHourFor10amLocal).toBe(14);
  });
});
