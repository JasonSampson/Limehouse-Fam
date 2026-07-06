import { describe, it, expect } from "vitest";
import {
  confirmDoorLossesFromHistory,
  confirmDoorLossesForPortfolio,
  CONFIRMATION_WINDOW_DAYS,
  type DailyPropertyActiveSnapshot,
} from "../../src/kpi/churnSnapshot.js";

function daysOfSnapshots(
  propertyId: string,
  startDate: string,
  activeFlags: boolean[]
): DailyPropertyActiveSnapshot[] {
  const start = new Date(startDate + "T00:00:00Z");
  return activeFlags.map((isActive, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    return { propertyId, snapshotDate: d.toISOString().slice(0, 10), isActive };
  });
}

describe("CONFIRMATION_WINDOW_DAYS", () => {
  it("is 30 days, per the coordinator's spec", () => {
    expect(CONFIRMATION_WINDOW_DAYS).toBe(30);
  });
});

describe("confirmDoorLossesFromHistory", () => {
  it("does NOT confirm a loss for a property that stays active the whole time", () => {
    const snapshots = daysOfSnapshots("1", "2026-06-01", Array(40).fill(true));
    expect(confirmDoorLossesFromHistory(snapshots)).toEqual([]);
  });

  it("does NOT confirm a loss for an inactive streak shorter than the confirmation window", () => {
    // Inactive for 10 days then back active — exactly the "pulled a
    // report" scenario Jason described, must not count as a loss.
    const flags = [...Array(10).fill(false), ...Array(5).fill(true)];
    const snapshots = daysOfSnapshots("1", "2026-06-01", flags);
    expect(confirmDoorLossesFromHistory(snapshots)).toEqual([]);
  });

  it("confirms a loss once an inactive streak exceeds the 30-day window, dated to when it started", () => {
    const flags = Array(35).fill(false);
    const snapshots = daysOfSnapshots("1", "2026-06-01", flags);
    const result = confirmDoorLossesFromHistory(snapshots);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      propertyId: "1",
      lossStartDate: "2026-06-01", // first inactive day, not day 31
      confirmedOnDate: "2026-07-01", // day 31 of the streak (June has 30 days) — the day it crossed the threshold
    });
  });

  it("does not re-confirm the same streak on every subsequent day once already confirmed", () => {
    const flags = Array(60).fill(false); // well past the confirmation point
    const snapshots = daysOfSnapshots("1", "2026-06-01", flags);
    const result = confirmDoorLossesFromHistory(snapshots);
    expect(result).toHaveLength(1); // exactly one confirmation event, not one per day past day 31
  });

  it("THE CORE SCENARIO: inactive, reactivated (report pull), inactive again within 30 days total — does NOT count as a loss", () => {
    // 10 days inactive, 2 days active (temporary reactivation to pull a
    // report), 15 days inactive again. Total elapsed time inactive-ish is
    // under 30 continuous days in either streak — must not be flagged.
    const flags = [...Array(10).fill(false), ...Array(2).fill(true), ...Array(15).fill(false)];
    const snapshots = daysOfSnapshots("1", "2026-06-01", flags);
    expect(confirmDoorLossesFromHistory(snapshots)).toEqual([]);
  });

  it("a real loss followed by a brief reactivation, then inactive again past 30 days, DOES eventually confirm — dated to the SECOND streak's start, not the first", () => {
    // First streak: 5 days inactive (too short, cleared by reactivation).
    // Reactivated for 3 days.
    // Second streak: 35 days inactive — long enough to confirm on its own.
    const flags = [...Array(5).fill(false), ...Array(3).fill(true), ...Array(35).fill(false)];
    const snapshots = daysOfSnapshots("1", "2026-06-01", flags);
    const result = confirmDoorLossesFromHistory(snapshots);
    expect(result).toHaveLength(1);
    // Second streak starts at day index 8 (5 inactive + 3 active = day 9, 0-indexed day 8)
    expect(result[0].lossStartDate).toBe("2026-06-09");
  });

  it("confirms a loss discovered well after the fact, still dated to the actual start of the streak", () => {
    const flags = Array(100).fill(false); // way past confirmation, e.g. discovered 100 days later
    const snapshots = daysOfSnapshots("1", "2026-01-01", flags);
    const result = confirmDoorLossesFromHistory(snapshots);
    expect(result).toHaveLength(1);
    expect(result[0].lossStartDate).toBe("2026-01-01");
  });

  it("returns an empty array for no snapshot history", () => {
    expect(confirmDoorLossesFromHistory([])).toEqual([]);
  });

  it("treats exactly 30 inactive days as NOT yet confirmed (window is 'more than 30', not 'at least 30')", () => {
    const flags = Array(30).fill(false);
    const snapshots = daysOfSnapshots("1", "2026-06-01", flags);
    expect(confirmDoorLossesFromHistory(snapshots)).toEqual([]);
  });

  it("confirms on day 31 of a continuous inactive streak", () => {
    const flags = Array(31).fill(false);
    const snapshots = daysOfSnapshots("1", "2026-06-01", flags);
    const result = confirmDoorLossesFromHistory(snapshots);
    expect(result).toHaveLength(1);
    expect(result[0].confirmedOnDate).toBe("2026-07-01"); // day 31
  });
});

describe("confirmDoorLossesForPortfolio", () => {
  it("processes multiple properties independently and does not cross-contaminate streaks", () => {
    const propertyA = daysOfSnapshots("A", "2026-06-01", Array(40).fill(false)); // confirmed loss
    const propertyB = daysOfSnapshots("B", "2026-06-01", Array(10).fill(false)); // too short, no loss
    const result = confirmDoorLossesForPortfolio([...propertyA, ...propertyB]);
    expect(result).toHaveLength(1);
    expect(result[0].propertyId).toBe("A");
  });

  it("sorts each property's rows chronologically even if the input array is out of order", () => {
    const orderedSnapshots = daysOfSnapshots("1", "2026-06-01", Array(35).fill(false));
    const shuffled = [...orderedSnapshots].reverse(); // deliberately out of order
    const result = confirmDoorLossesForPortfolio(shuffled);
    expect(result).toHaveLength(1);
    expect(result[0].lossStartDate).toBe("2026-06-01");
  });

  it("returns an empty array for no snapshots at all", () => {
    expect(confirmDoorLossesForPortfolio([])).toEqual([]);
  });
});
