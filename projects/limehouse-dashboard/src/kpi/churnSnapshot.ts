// Go-forward Doors Lost tracking (Occupancy & Doors section) — the EXACT,
// non-estimated version. Requires a daily snapshot of every property's
// IsActive state, taken once per day starting the day this ships, and
// compared against the running snapshot history.
//
// WHY THIS DIFFERS FROM src/kpi/churn.ts's estimatePropertyLossDates: that
// function is a one-time retroactive estimate from today's IsActive state
// alone (no history exists to check reactivation against). This module is
// for the ongoing mechanism, built correctly from day one per the
// coordinator's instruction — it consumes a running history of daily
// snapshots and only confirms a door as "lost" once a property has been
// continuously IsActive:false for more than CONFIRMATION_WINDOW_DAYS.
//
// OPERATIONAL CONTEXT (Jason, via the coordinator): his team routinely
// reactivates a property TEMPORARILY just to pull tenant/property data or
// send an owner a report (Buildium hides data on inactive properties),
// then flips it back to inactive. A raw active→inactive transition is
// therefore NOT reliable on its own — a property could go inactive, come
// back active for a day, then go inactive again, and naive edge-detection
// would count that as two separate "lost then regained then lost again"
// events instead of one continuous loss. The rule implemented here: an
// inactive streak only counts as a confirmed loss once it has lasted MORE
// THAN 30 days without a real activation in between. A same-day or
// short-lived reactivation (under the confirmation window) does not reset
// or fragment the underlying loss — the ORIGINAL date the property first
// went inactive (in the current unconfirmed streak) is preserved as the
// loss date once/if it's later confirmed.
//
// STORAGE NOTE: this module is pure logic over a plain array of daily
// snapshot rows — it does not read or write a database itself. The
// history needs to persist somewhere daily-durable (a new table, most
// likely — this doesn't fit dashboard_metric_cache's single-row-per-key
// shape, which has no history, or dashboard_kpi_snapshots' quarterly/
// KPI-scored shape). That's a schema decision belonging to Neo, not
// decided here — this file only defines the confirmation-window state
// machine so it's ready to wire up the moment a daily snapshot table
// exists. Nothing in this file runs yet; there is no cron/scheduler
// wiring it up, and no historical snapshots exist to feed it (today would
// be day one).
export const CONFIRMATION_WINDOW_DAYS = 30;

export interface DailyPropertyActiveSnapshot {
  propertyId: string;
  snapshotDate: string; // "YYYY-MM-DD", one row per property per day
  isActive: boolean;
}

export interface ConfirmedDoorLoss {
  propertyId: string;
  // The date the property FIRST went inactive in the streak that was
  // ultimately confirmed as a real loss — not the date it crossed the
  // 30-day confirmation threshold. A loss that's discovered 45 days after
  // the fact should still be attributed to when it actually happened.
  lossStartDate: string;
  confirmedOnDate: string; // the snapshot date on which the streak crossed the confirmation window
}

// Walks one property's snapshot history (assumed already sorted
// oldest-to-newest by the caller, one row per calendar day with no gaps —
// a gap in daily snapshots is a data-collection problem to fix upstream,
// not something this function should silently paper over by assuming a
// value) and returns every REAL, confirmed loss found in that history.
//
// State machine: track the start of the current unconfirmed inactive
// streak. Any day with isActive:true resets/clears that streak (the
// property is, as of that day, back in active management — whether that
// reactivation was "real" or just Jason's team pulling a report is not
// knowable from IsActive alone, so ANY active day breaks a streak that
// hasn't yet been confirmed). Once an inactive streak's length exceeds
// CONFIRMATION_WINDOW_DAYS, it is confirmed as a real loss, dated to when
// the streak started — and confirmation happens only ONCE per streak (a
// streak that's already been confirmed doesn't get re-confirmed every
// subsequent day it remains inactive).
export function confirmDoorLossesFromHistory(
  snapshots: DailyPropertyActiveSnapshot[]
): ConfirmedDoorLoss[] {
  const confirmedLosses: ConfirmedDoorLoss[] = [];

  let currentStreakStart: string | null = null;
  let streakAlreadyConfirmed = false;

  for (const snapshot of snapshots) {
    if (snapshot.isActive) {
      // Any active day — real reactivation or just a temporary flip to
      // pull data — clears the current inactive streak. If that streak
      // had already been confirmed as a loss, the confirmation stands
      // (already recorded in confirmedLosses); if it hadn't yet crossed
      // the window, it's discarded entirely, exactly as intended: a
      // property that went inactive for 10 days and came back is NOT a
      // door lost.
      currentStreakStart = null;
      streakAlreadyConfirmed = false;
      continue;
    }

    // Inactive day.
    if (currentStreakStart === null) {
      currentStreakStart = snapshot.snapshotDate;
      streakAlreadyConfirmed = false;
    }

    if (streakAlreadyConfirmed) continue; // this streak already produced its one confirmation event

    const streakLengthDays = daysBetween(currentStreakStart, snapshot.snapshotDate) + 1; // inclusive of the first inactive day
    if (streakLengthDays > CONFIRMATION_WINDOW_DAYS) {
      confirmedLosses.push({
        propertyId: snapshot.propertyId,
        lossStartDate: currentStreakStart,
        confirmedOnDate: snapshot.snapshotDate,
      });
      streakAlreadyConfirmed = true;
    }
  }

  return confirmedLosses;
}

// Convenience wrapper: groups a multi-property snapshot table by
// propertyId (sorting each property's own rows chronologically — the
// caller's overall array does not need to already be grouped/sorted) and
// runs confirmDoorLossesFromHistory per property.
export function confirmDoorLossesForPortfolio(
  allSnapshots: DailyPropertyActiveSnapshot[]
): ConfirmedDoorLoss[] {
  const byProperty = new Map<string, DailyPropertyActiveSnapshot[]>();
  for (const snapshot of allSnapshots) {
    const bucket = byProperty.get(snapshot.propertyId);
    if (bucket) {
      bucket.push(snapshot);
    } else {
      byProperty.set(snapshot.propertyId, [snapshot]);
    }
  }

  const allLosses: ConfirmedDoorLoss[] = [];
  for (const propertySnapshots of byProperty.values()) {
    const sorted = [...propertySnapshots].sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
    allLosses.push(...confirmDoorLossesFromHistory(sorted));
  }
  return allLosses;
}

function daysBetween(fromDateStr: string, toDateStr: string): number {
  const from = new Date(fromDateStr);
  const to = new Date(toDateStr);
  return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}
