import { describe, it, expect } from "vitest";
import { resolvePeriod, periodToSnapshotLabel } from "../../src/kpi/period.js";

// Fixed "now" for deterministic tests: July 3, 2026 (Q3).
const NOW = new Date("2026-07-03T12:00:00Z");

describe("resolvePeriod", () => {
  it("this_month clamps to today, not the full calendar month", () => {
    expect(resolvePeriod("this_month", NOW)).toEqual({ from: "2026-07-01", to: "2026-07-03" });
  });

  it("last_month", () => {
    expect(resolvePeriod("last_month", NOW)).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  });

  it("last_month rolls back across a year boundary correctly", () => {
    const jan = new Date("2026-01-15T00:00:00Z");
    expect(resolvePeriod("last_month", jan)).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("this_quarter clamps to today, not the full calendar quarter", () => {
    // July is Q3: Jul-Sep, but today is Jul 3
    expect(resolvePeriod("this_quarter", NOW)).toEqual({ from: "2026-07-01", to: "2026-07-03" });
  });

  it("this_month/this_quarter/this_year do not clamp when today is already past the natural end", () => {
    // Sanity check: clamping only kicks in when the natural end is in the future.
    const endOfMonth = new Date("2026-07-31T12:00:00Z");
    expect(resolvePeriod("this_month", endOfMonth)).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });

  it("last_quarter", () => {
    // Q3 - 1 = Q2: Apr-Jun
    expect(resolvePeriod("last_quarter", NOW)).toEqual({ from: "2026-04-01", to: "2026-06-30" });
  });

  it("last_quarter rolls back across a year boundary correctly (Q1 -> prior Q4)", () => {
    const feb = new Date("2026-02-15T00:00:00Z");
    expect(resolvePeriod("last_quarter", feb)).toEqual({ from: "2025-10-01", to: "2025-12-31" });
  });

  it("this_year clamps to today, not the full calendar year", () => {
    expect(resolvePeriod("this_year", NOW)).toEqual({ from: "2026-01-01", to: "2026-07-03" });
  });

  it("last_year", () => {
    expect(resolvePeriod("last_year", NOW)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
  });
});

describe("periodToSnapshotLabel", () => {
  it("maps this_quarter to the current quarter label", () => {
    expect(periodToSnapshotLabel("this_quarter", NOW)).toBe("2026-Q3");
  });

  it("maps last_quarter to the prior quarter label", () => {
    expect(periodToSnapshotLabel("last_quarter", NOW)).toBe("2026-Q2");
  });

  it("maps last_quarter across a year boundary", () => {
    const feb = new Date("2026-02-15T00:00:00Z");
    expect(periodToSnapshotLabel("last_quarter", feb)).toBe("2025-Q4");
  });
});
