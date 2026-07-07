import type { BuildiumOwner, BuildiumProperty, BuildiumLease } from "../buildium/client.js";

// Doors Added (Occupancy & Doors section). CONFIRMED LIVE 2026-07-03:
// ManagementAgreementStartDate on /rentals/owners records is a real,
// populated field for this account (262 of 383 owner records have one) —
// a property's earliest known management-agreement start date is a
// legitimate "when did this door join the portfolio" signal. Verified live
// counts for this account as of today: 5 doors added in the last 30 days,
// 11 in 60 days, 17 in 90 days.
//
// Doors Lost (ESTIMATED) — ManagementAgreementEndDate is NOT used (stale
// for this account: only 12 of 383 owner records have any end date at
// all, most recent 2023 — cannot be tracking Jason's real recent churn).
// CONFIRMED proxy instead (Oracle's research): for a property that is
// CURRENTLY IsActive:false, the most recent LeaseToDate across all of its
// leases is a reasonable approximate "loss date" — the last time a tenant
// was scheduled to move out is a decent stand-in for "when this door
// stopped being managed," even though it's not the actual
// deactivation-in-Buildium date. Verified live for this account: 2 doors
// lost in the last 31 days, 26 in the last 12 months — matches Oracle's
// numbers exactly.
//
// This is explicitly an ESTIMATE, not a real "date the property went
// inactive" figure, and is labeled that way everywhere it surfaces
// (doorsLostEstimated, not doorsLost). Two known limitations, both
// deliberately left visible rather than silently smoothed over:
//   1. UNDERCOUNTS properties that never had a Buildium lease at all (38
//      of 122 inactive properties, confirmed live, have zero lease
//      records — there's no LeaseToDate to derive a loss date from, so
//      these are simply absent from the estimate rather than guessed at).
//   2. This is a ONE-TIME retroactive snapshot computed from today's
//      IsActive state — it has no way to know whether a property was
//      temporarily reactivated and then went inactive again (Jason's team
//      routinely flips a property active just to pull data/send an owner
//      report, then flips it back). The 30-day "must stay inactive"
//      confirmation rule the coordinator specified only applies to the
//      GO-FORWARD daily snapshot mechanism (see churnSnapshot.ts) — there
//      is no history of past active/inactive flips to apply that rule to
//      retroactively, so this estimate takes today's IsActive:false at
//      face value for every property currently in that state.
//
// DATA QUALITY WRINKLE, confirmed live: a property can have more than one
// owner record (co-owners), and their ManagementAgreementStartDate values
// sometimes disagree — in a few cases by YEARS, not days (5 properties out
// of 201 active ones, confirmed live; the largest disagreement seen was
// over 1,100 days apart). This looks like a Buildium data-entry quirk
// (e.g. a co-owner added to the property record later, long after the
// actual management start), not a bug in this code. The EARLIEST non-null
// date across all owners of a property is used — a later co-owner join
// date should never overwrite an earlier real start date — and any
// disagreement over DISAGREEMENT_FLAG_THRESHOLD_DAYS is surfaced in
// flaggedDisagreements so it stays visible rather than silently resolved.
const DISAGREEMENT_FLAG_THRESHOLD_DAYS = 30;

export interface PropertyManagementStart {
  propertyId: string;
  earliestStartDate: string; // "YYYY-MM-DD"
}

export interface OwnerStartDateDisagreement {
  propertyId: string;
  earliestStartDate: string;
  latestStartDate: string;
  diffDays: number;
}

export interface PropertyManagementStartResult {
  properties: PropertyManagementStart[];
  flaggedDisagreements: OwnerStartDateDisagreement[];
}

// `activePropertyIds` scopes this to properties Jason actually manages
// today (same IsActive===true && RentalType==='Residential' filter used
// throughout this dashboard) — an owner record can reference a property
// that's since gone inactive, and that should not count as a "door" for
// this tile.
//
// CONFIRMED LIVE 2026-07-07, per Jason: ManagementAgreementStartDate gets
// RESET when an owner re-signs a management agreement — e.g. an LLC
// changing to the owner's personal name on the deed (a real case: 481
// Rudder Road, managed for years, re-signed 2026-03-26 purely for the name
// change) — even though the door was never actually lost or re-added.
// Confirmed against 4 real properties (1309 Sierra Drive, 900 Southmoor
// Drive, 481 Rudder Road, 1328 Conrad Lane) that all had a 2026 agreement
// date but a real first lease from 2022 or 2023 — years earlier. A lease
// can't exist before the door was under management, so the property's
// EARLIEST lease start date is a hard floor on the true start date; this
// now takes whichever of (earliest agreement date, earliest lease date) is
// EARLIER, per Jason's own suggested check ("look at when the first tenant
// was placed").
export function buildPropertyManagementStarts(
  owners: BuildiumOwner[],
  activePropertyIds: Set<string>,
  allLeases: BuildiumLease[]
): PropertyManagementStartResult {
  const startDatesByProperty = new Map<string, string[]>();

  for (const owner of owners) {
    if (!owner.ManagementAgreementStartDate || !owner.PropertyIds) continue;
    for (const propertyId of owner.PropertyIds) {
      const key = String(propertyId);
      if (!activePropertyIds.has(key)) continue;
      const existing = startDatesByProperty.get(key);
      if (existing) {
        existing.push(owner.ManagementAgreementStartDate);
      } else {
        startDatesByProperty.set(key, [owner.ManagementAgreementStartDate]);
      }
    }
  }

  const earliestLeaseFromByProperty = new Map<string, string>();
  for (const lease of allLeases) {
    if (!lease.LeaseFromDate) continue;
    const key = String(lease.PropertyId);
    const existing = earliestLeaseFromByProperty.get(key);
    if (!existing || lease.LeaseFromDate < existing) {
      earliestLeaseFromByProperty.set(key, lease.LeaseFromDate);
    }
  }

  const properties: PropertyManagementStart[] = [];
  const flaggedDisagreements: OwnerStartDateDisagreement[] = [];

  for (const [propertyId, dates] of startDatesByProperty.entries()) {
    const sorted = [...dates].sort();
    const earliestAgreementDate = sorted[0];
    const latestStartDate = sorted[sorted.length - 1];
    const earliestLeaseDate = earliestLeaseFromByProperty.get(propertyId);
    const earliestStartDate =
      earliestLeaseDate && earliestLeaseDate < earliestAgreementDate ? earliestLeaseDate : earliestAgreementDate;

    properties.push({ propertyId, earliestStartDate });

    if (dates.length >= 2 && earliestAgreementDate !== latestStartDate) {
      const diffDays = daysBetween(earliestAgreementDate, latestStartDate);
      if (diffDays > DISAGREEMENT_FLAG_THRESHOLD_DAYS) {
        flaggedDisagreements.push({ propertyId, earliestStartDate: earliestAgreementDate, latestStartDate, diffDays });
      }
    }
  }

  return { properties, flaggedDisagreements };
}

// ============================================================================
// Net Doors — EXACT, year-to-date (added 2026-07-07 per Jason's real data).
// CONFIRMED LIVE: the vendor's own "Net Doors" tile is labeled "trailing 12
// months" but its own drill-down admits it's really a daily-snapshot diff
// that only started ~2026-05-18 (its own "50 day(s) of coverage" note) —
// it isn't a true 12-month figure either, so matching it exactly isn't a
// meaningful target. Jason has his own real door counts (units under
// management) as of January 1st each year, which lets Net Doors be an
// EXACT calendar-year-to-date figure instead of an estimate: current total
// doors minus the door count at the start of this year.
const DOOR_COUNT_ANCHORS_BY_YEAR: Record<number, number> = {
  2023: 137,
  2024: 169,
  2025: 222,
  2026: 218,
};

export interface NetDoorsYTD {
  netDoors: number;
  sinceDate: string; // "YYYY-01-01"
  doorsAtStartOfYear: number;
  currentTotalDoors: number;
}

// Returns null when there's no known anchor for asOfDate's year (e.g. a
// future year Jason hasn't given us a starting count for yet) — an honest
// "no data" rather than guessing forward from the last known anchor.
export function summarizeNetDoorsYTD(currentTotalDoors: number, asOfDate: Date): NetDoorsYTD | null {
  const year = asOfDate.getUTCFullYear();
  const doorsAtStartOfYear = DOOR_COUNT_ANCHORS_BY_YEAR[year];
  if (doorsAtStartOfYear === undefined) return null;
  return {
    netDoors: currentTotalDoors - doorsAtStartOfYear,
    sinceDate: `${year}-01-01`,
    doorsAtStartOfYear,
    currentTotalDoors,
  };
}

export interface DoorsAddedSummary {
  doorsAdded30Days: number;
  doorsAdded60Days: number;
  doorsAdded90Days: number;
  // ADDED 2026-07-05 for Net Doors (see the drill-down route in
  // dashboardRoutes.ts): the vendor's "Doors Added vs Lost — 12 Months"
  // metric compares BOTH sides over the same 12-month window. Doors Lost
  // already had a 12-month figure; Doors Added didn't, so Net Doors was
  // subtracting a 12-month "lost" count from a 90-day "added" count —
  // two different time spans mixed into one number. This field gives
  // Doors Added its own matching 365-day window.
  doorsAdded365Days: number;
  // ADDED 2026-07-07: Net Doors (Top of Mind) is now an EXACT year-to-date
  // figure (see summarizeNetDoorsYTD above), so Doors Added/Lost switch to
  // the same year-to-date framing for consistency — "since Jan 1" rather
  // than a rolling window, even though this specific field is still an
  // ESTIMATE (no real anchor for the gross added/lost split, only the net).
  // CONFIRMED LIVE 2026-07-07: unlike the 30/60/90/365-day windows, YTD
  // does NOT exclude a near-future agreement date — a real case (1342
  // Little Bay Avenue, signed with a 2026-07-10 start a few days out) is a
  // door Jason already counts as added this year, not a data gap. Same
  // "already scheduled counts" precedent as the Renewal Rate rebuild.
  doorsAddedYTD: number;
}

export function summarizeDoorsAdded(properties: PropertyManagementStart[], asOfDate: Date): DoorsAddedSummary {
  let doorsAdded30Days = 0;
  let doorsAdded60Days = 0;
  let doorsAdded90Days = 0;
  let doorsAdded365Days = 0;
  let doorsAddedYTD = 0;
  const startOfYear = `${asOfDate.getUTCFullYear()}-01-01`;
  const startOfNextYear = `${asOfDate.getUTCFullYear() + 1}-01-01`;

  for (const p of properties) {
    // Bounded on both ends: a near-future date still within THIS calendar
    // year counts (see 1342 Little Bay Ave above), but a date in a later
    // year must not.
    if (p.earliestStartDate >= startOfYear && p.earliestStartDate < startOfNextYear) doorsAddedYTD++;

    const daysAgo = daysBetween(p.earliestStartDate, toDateString(asOfDate));
    if (daysAgo < 0) continue; // a start date in the future is a data gap, not a door added yet
    if (daysAgo <= 30) doorsAdded30Days++;
    if (daysAgo <= 60) doorsAdded60Days++;
    if (daysAgo <= 90) doorsAdded90Days++;
    if (daysAgo <= 365) doorsAdded365Days++;
  }

  return { doorsAdded30Days, doorsAdded60Days, doorsAdded90Days, doorsAdded365Days, doorsAddedYTD };
}

// ============================================================================
// Doors Lost (ESTIMATED) — see file header for the full derivation and its
// two documented limitations.
// ============================================================================

export interface PropertyLossEstimate {
  propertyId: string;
  estimatedLossDate: string; // "YYYY-MM-DD" — most recent LeaseToDate across the property's leases
}

// `inactiveProperties` should be the FULL raw property list filtered to
// IsActive === false by the caller (not scoped to "active residential" —
// that filter would exclude every property this function needs to look
// at). `allLeases` should span every lease status (Active/Past/Future) —
// a lease that already ended is exactly the signal this estimate needs.
export function estimatePropertyLossDates(
  inactiveProperties: BuildiumProperty[],
  allLeases: BuildiumLease[]
): PropertyLossEstimate[] {
  const latestLeaseToDateByProperty = new Map<string, string>();
  for (const lease of allLeases) {
    if (!lease.LeaseToDate) continue;
    const key = String(lease.PropertyId);
    const existing = latestLeaseToDateByProperty.get(key);
    if (!existing || lease.LeaseToDate > existing) {
      latestLeaseToDateByProperty.set(key, lease.LeaseToDate);
    }
  }

  const estimates: PropertyLossEstimate[] = [];
  for (const property of inactiveProperties) {
    const key = String(property.Id);
    const estimatedLossDate = latestLeaseToDateByProperty.get(key);
    // A property with no lease record at all has no LeaseToDate to derive
    // a loss date from — this is the documented undercount, not a gap to
    // paper over with a guess (e.g. "assume today" or "assume the
    // deactivation must have just happened").
    if (estimatedLossDate) {
      estimates.push({ propertyId: key, estimatedLossDate });
    }
  }

  return estimates;
}

export interface DoorsLostEstimateSummary {
  doorsLost31Days: number;
  doorsLost12Months: number;
  propertiesUndercounted: number; // inactive properties with no lease record to estimate from
  // ADDED 2026-07-07 — see doorsAddedYTD above for why: same "since Jan 1"
  // framing to match the now-exact Net Doors figure.
  doorsLostYTD: number;
}

export function summarizeDoorsLostEstimate(
  estimates: PropertyLossEstimate[],
  totalInactiveProperties: number,
  asOfDate: Date
): DoorsLostEstimateSummary {
  let doorsLost31Days = 0;
  let doorsLost12Months = 0;
  let doorsLostYTD = 0;
  const startOfYear = `${asOfDate.getUTCFullYear()}-01-01`;

  for (const e of estimates) {
    const daysAgo = daysBetween(e.estimatedLossDate, toDateString(asOfDate));
    if (daysAgo < 0) continue; // an estimated loss date in the future is a data gap, not a loss yet
    if (daysAgo <= 31) doorsLost31Days++;
    if (daysAgo <= 365) doorsLost12Months++;
    if (e.estimatedLossDate >= startOfYear) doorsLostYTD++;
  }

  return {
    doorsLost31Days,
    doorsLost12Months,
    propertiesUndercounted: totalInactiveProperties - estimates.length,
    doorsLostYTD,
  };
}

// ============================================================================
// Net Doors drill-down rows (the /api/dashboard/net-doors/properties route
// in dashboardRoutes.ts just calls this rather than filtering inline).
// ============================================================================

export interface NetDoorRow {
  propertyId: string;
  type: "added" | "lost";
  date: string;
}

// FIXED 2026-07-05, two bugs found by TARS:
//   1. Both "added" and "lost" used to have no lower bound on daysAgo, so a
//      property with a FUTURE ManagementAgreementStartDate (CONFIRMED LIVE:
//      property 701423, start date 2026-07-10, in the future relative to
//      "today" at time of testing) got counted as already "added." The
//      SUMMARY tiles (summarizeDoorsAdded/summarizeDoorsLostEstimate above)
//      already guard against this with `daysAgo < 0` — this drill-down now
//      matches that.
//   2. "Added" used to use a 90-day window while "lost" used 12 months
//      (365 days) — two different time spans subtracted into one "Net
//      Doors" number isn't meaningful. Both sides now use the SAME
//      12-month window, matching the vendor's "Doors Added vs Lost — 12
//      Months" metric.
export function netDoorsRows(
  properties: PropertyManagementStart[],
  lossEstimates: PropertyLossEstimate[],
  asOfDate: Date
): NetDoorRow[] {
  const today = toDateString(asOfDate);

  const added: NetDoorRow[] = properties
    .filter((p) => {
      const daysAgo = daysBetween(p.earliestStartDate, today);
      return daysAgo >= 0 && daysAgo <= 365;
    })
    .map((p) => ({ propertyId: p.propertyId, type: "added", date: p.earliestStartDate }));

  const lost: NetDoorRow[] = lossEstimates
    .filter((e) => {
      const daysAgo = daysBetween(e.estimatedLossDate, today);
      return daysAgo >= 0 && daysAgo <= 365;
    })
    .map((e) => ({ propertyId: e.propertyId, type: "lost", date: e.estimatedLossDate }));

  return [...added, ...lost].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

function daysBetween(fromDateStr: string, toDateStr: string): number {
  const from = new Date(fromDateStr);
  const to = new Date(toDateStr);
  return Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
