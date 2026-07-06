import { describe, it, expect } from "vitest";
import { enumerateMonthsThrough } from "../../src/buildium/financialHistorySync.js";

describe("enumerateMonthsThrough", () => {
  it("enumerates every calendar month from 2018-01 through the month containing `now`", () => {
    const months = enumerateMonthsThrough(new Date("2018-03-15T12:00:00Z"));
    expect(months.map((m) => m.month)).toEqual(["2018-01", "2018-02", "2018-03"]);
  });

  it("marks only the month containing `now` as the current (open) month", () => {
    const months = enumerateMonthsThrough(new Date("2026-07-05T12:00:00Z"));
    const flags = months.map((m) => ({ month: m.month, isCurrentMonth: m.isCurrentMonth }));
    expect(flags[flags.length - 1]).toEqual({ month: "2026-07", isCurrentMonth: true });
    expect(flags.slice(0, -1).every((f) => f.isCurrentMonth === false)).toBe(true);
  });

  it("clamps the current month's end date to today rather than the full calendar month (no future-dated query range)", () => {
    const months = enumerateMonthsThrough(new Date("2026-07-05T12:00:00Z"));
    const current = months[months.length - 1];
    expect(current.monthStart).toBe("2026-07-01");
    expect(current.monthEnd).toBe("2026-07-05"); // NOT 2026-07-31
  });

  it("uses the full calendar month end date for any past, fully-closed month", () => {
    const months = enumerateMonthsThrough(new Date("2026-07-05T12:00:00Z"));
    const june = months.find((m) => m.month === "2026-06");
    expect(june?.monthStart).toBe("2026-06-01");
    expect(june?.monthEnd).toBe("2026-06-30");
  });

  it("handles February correctly across a leap and non-leap year (past, fully-closed Februaries)", () => {
    // `now` is set to March so both Februaries below are past/closed months,
    // not the in-progress current month (which is clamped to today instead
    // of the full month-end — see the clamping test above).
    const months2020 = enumerateMonthsThrough(new Date("2020-03-01T00:00:00Z"));
    const feb2020 = months2020.find((m) => m.month === "2020-02");
    expect(feb2020?.monthEnd).toBe("2020-02-29"); // leap year

    const months2019 = enumerateMonthsThrough(new Date("2019-03-01T00:00:00Z"));
    const feb2019 = months2019.find((m) => m.month === "2019-02");
    expect(feb2019?.monthEnd).toBe("2019-02-28");
  });

  it("assigns the correct year to each month", () => {
    const months = enumerateMonthsThrough(new Date("2019-01-15T00:00:00Z"));
    expect(months.every((m) => m.year === 2018 || m.year === 2019)).toBe(true);
    expect(months.find((m) => m.month === "2018-12")?.year).toBe(2018);
    expect(months.find((m) => m.month === "2019-01")?.year).toBe(2019);
  });
});
