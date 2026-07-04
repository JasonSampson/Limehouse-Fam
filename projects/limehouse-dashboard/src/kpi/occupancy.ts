import type { BuildiumLease } from "../buildium/client.js";

// Occupancy / lease-mix calculations. These are STRUCTURAL metrics (per the
// project brief's flow vs. structural distinction) — they always reflect
// "as of today," never a historical period, so callers must not pass a
// period range into these and must not cache results keyed by period.
export interface OccupancySummary {
  totalUnits: number;
  occupiedUnits: number;
  vacantUnits: number;
  occupancyRatePercent: number;
}

// occupied = has an Active lease attached to that unit. totalUnits comes
// from the caller (Buildium unit records), not derived from lease count,
// because a unit can have zero leases (never-leased vacant unit) and would
// otherwise be invisible to a lease-based count.
export function summarizeOccupancy(totalUnits: number, activeLeases: BuildiumLease[]): OccupancySummary {
  // A unit could theoretically have more than one "Active" lease record
  // during a transition; count DISTINCT unit ids as occupied, not lease
  // rows, so occupancy never exceeds totalUnits.
  const occupiedUnitIds = new Set(activeLeases.map((l) => l.UnitId));
  const occupiedUnits = Math.min(occupiedUnitIds.size, totalUnits);
  const vacantUnits = Math.max(totalUnits - occupiedUnits, 0);
  const occupancyRatePercent = totalUnits > 0 ? roundPercent((occupiedUnits / totalUnits) * 100) : 0;

  return { totalUnits, occupiedUnits, vacantUnits, occupancyRatePercent };
}

export interface LeaseMixSummary {
  fixedTermCount: number;
  monthToMonthCount: number;
  evictionPendingCount: number;
  totalActiveLeaseCount: number;
}

// LeaseType values confirmed via Buildium's OpenAPI spec: "Fixed" and
// "FixedWithRollover" are both fixed-term leases (the rollover variant just
// auto-renews into another fixed term rather than going month-to-month);
// "AtWill" is Buildium's name for a month-to-month lease. Any other/unknown
// LeaseType value is counted as neither bucket rather than guessed, so an
// unexpected value shows up as a gap in the totals (fixedTermCount +
// monthToMonthCount < totalActiveLeaseCount) instead of being silently
// misclassified.
export function summarizeLeaseMix(activeLeases: BuildiumLease[]): LeaseMixSummary {
  let fixedTermCount = 0;
  let monthToMonthCount = 0;
  let evictionPendingCount = 0;

  for (const lease of activeLeases) {
    if (lease.LeaseType === "Fixed" || lease.LeaseType === "FixedWithRollover") {
      fixedTermCount++;
    } else if (lease.LeaseType === "AtWill") {
      monthToMonthCount++;
    }
    if (lease.IsEvictionPending) {
      evictionPendingCount++;
    }
  }

  return {
    fixedTermCount,
    monthToMonthCount,
    evictionPendingCount,
    totalActiveLeaseCount: activeLeases.length,
  };
}

// Renewals coming up: leases ending within `withinDays` of `asOfDate`.
// FLOW-classified in the sense that "within N days" depends on a lookahead
// window, but per the brief's own examples ("60 days and 30 days before
// expiration") the window length is a fixed operational rule, not a
// dashboard period selector — so this does NOT take a period param, only
// asOfDate (defaults to now) and the window length.
export interface UpcomingRenewalRow {
  leaseId: string;
  propertyId: string;
  leaseToDate: string;
  daysUntilExpiration: number;
}

export function upcomingRenewals(activeLeases: BuildiumLease[], asOfDate: Date, withinDays: number): UpcomingRenewalRow[] {
  const asOfMs = asOfDate.getTime();
  const rows: UpcomingRenewalRow[] = [];

  for (const lease of activeLeases) {
    if (!lease.LeaseToDate) continue; // month-to-month leases have no end date
    const endMs = new Date(lease.LeaseToDate).getTime();
    const daysUntil = Math.round((endMs - asOfMs) / (1000 * 60 * 60 * 24));
    if (daysUntil >= 0 && daysUntil <= withinDays) {
      rows.push({
        leaseId: String(lease.Id),
        propertyId: String(lease.PropertyId),
        leaseToDate: lease.LeaseToDate,
        daysUntilExpiration: daysUntil,
      });
    }
  }

  return rows.sort((a, b) => a.daysUntilExpiration - b.daysUntilExpiration);
}

function roundPercent(n: number): number {
  return Math.round(n * 10) / 10;
}
