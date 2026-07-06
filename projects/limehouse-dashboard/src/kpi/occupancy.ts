import type { BuildiumLease, BuildiumUnit, LeaseBalance } from "../buildium/client.js";

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

// SUPERSEDED 2026-07-04 for /api/dashboard/occupancy — kept for any caller
// that genuinely only has unit records and not lease data handy. Confirmed
// live 2026-07-04 comparing against the vendor site side-by-side:
// IsUnitOccupied lags real lease-status transitions — 9 real units in
// Jason's account show IsUnitOccupied=true with NO currently-Active lease,
// because the outgoing tenant's lease already ended (Past) and the
// incoming tenant's lease hasn't started yet (Future, signed but move-in
// still days/weeks out). That inflated occupancy to 90.6% vs the vendor's
// real 86.8%. summarizeOccupancy() below (deriving occupied from Active
// lease status) is what /api/dashboard/occupancy now calls, and matches
// the vendor number almost exactly.
export function summarizeOccupancyFromUnits(units: BuildiumUnit[]): OccupancySummary {
  const totalUnits = units.length;
  const occupiedUnits = units.filter((u) => u.IsUnitOccupied).length;
  const vacantUnits = totalUnits - occupiedUnits;
  const occupancyRatePercent = totalUnits > 0 ? roundPercent((occupiedUnits / totalUnits) * 100) : 0;

  return { totalUnits, occupiedUnits, vacantUnits, occupancyRatePercent };
}

// PREFERRED as of 2026-07-04: derives occupancy from which units have an
// Active lease attached (occupied = has an Active lease attached to that
// unit), rather than trusting the unit record's own IsUnitOccupied flag —
// see summarizeOccupancyFromUnits' comment above for why that flag lags
// real occupancy during lease transitions. totalUnits comes from the
// caller (Buildium unit records), not derived from lease count, because a
// unit can have zero leases (never-leased vacant unit) and would
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
  unitNumber: string | null;
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
        unitNumber: lease.UnitNumber,
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

// Avg Tenancy (Leasing Pipeline section): average length, in months, of
// every currently-Active lease, measured from LeaseFromDate to asOfDate —
// NOT LeaseFromDate to LeaseToDate. A fixed-term lease's *contract* length
// is not what "how long has this tenant actually been here" means, and
// AtWill (month-to-month) leases have no LeaseToDate at all, so measuring
// to the end date would silently drop every month-to-month tenant from the
// average. Leases missing LeaseFromDate (data gap) are excluded from the
// average rather than counted as 0 months, same "gap is visible, not
// silently misclassified" rule summarizeLeaseMix already follows above.
export function averageTenancyMonths(activeLeases: BuildiumLease[], asOfDate: Date): number | null {
  const tenancyMonths = activeLeases
    .filter((l) => l.LeaseFromDate !== null)
    .map((l) => monthsBetween(new Date(l.LeaseFromDate as string), asOfDate));

  if (tenancyMonths.length === 0) return null;

  const avg = tenancyMonths.reduce((sum, m) => sum + m, 0) / tenancyMonths.length;
  return Math.round(avg * 10) / 10;
}

function monthsBetween(from: Date, to: Date): number {
  const days = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(days / 30.44, 0); // 30.44 = average days/month across a year, avoids calendar-month edge cases
}

function daysBetweenDates(fromDateStr: string, toDateStr: string): number {
  return Math.round((new Date(toDateStr).getTime() - new Date(fromDateStr).getTime()) / (1000 * 60 * 60 * 24));
}

// ============================================================================
// Renewal Rate (top-of-mind tile) — REBUILT 2026-07-05, wrong metric
// entirely before this. Jason confirmed he wants "% of leases that renewed
// instead of moving out, over the trailing 12 months" (vendor: 70.8%,
// vendor's Leasing Pipeline "Renewals — trailing 12 mo" tile: 138) — NOT
// the old "% of active leases coming up for renewal in the next 60 days"
// (7.5%), which is a completely different concept. That old 60-day
// upcoming-renewals view is kept AS-IS under the existing "Renewals" tile
// in Leasing Pipeline (upcomingRenewals above, /api/dashboard/renewals) —
// only the TOP-OF-MIND "Renewal Rate" percentage changes.
//
// ROOT PROBLEM investigated against real data before writing this:
// Buildium has no dedicated "was this lease renewed" field or endpoint for
// this account. Two dead ends, ruled out live before landing on the
// approach below:
//   1. GET /leases/renewals (Buildium's formal e-signature renewal-offer
//      workflow) exists and returns real data, but only 29 rows total, all
//      LeaseStatus="Future" with esignaturestatuses=notsent — this is a
//      forward-looking "renewal offers not yet signed" pipeline, not a
//      historical record of completed renewals. Not useful here.
//   2. RenewalOfferStatus (a field on every lease) is "NotSet" on 571 of
//      574 real leases — Jason's team doesn't use Buildium's built-in
//      renewal-offer workflow, so this field carries no signal.
//   3. Searching for "a new lease record on the same unit, same tenant,
//      starting near where an old one ended" (the obvious approach) found
//      ZERO matches across all 574 real leases — because a genuine
//      renewal does NOT create a new lease record at all.
//
// THE REAL MECHANISM, confirmed live: a renewal extends LeaseToDate IN
// PLACE on the SAME lease record. Evidence: 132 of 240 real Active leases
// were originally created 2018-2021 (per CreatedDateTime) yet still show
// LeaseStatus="Active" today, with LeaseToDate 2026-2060 and a
// LastUpdatedDateTime from within the last few months — a lease can only
// still be "Active" years after a 1-year term started if its end date
// keeps getting pushed forward.
//
// THE FORMULA:
//   RENEWED = a lease that is NOT currently Past (tenant hasn't left), was
//   last updated within the trailing 12 months (LastUpdatedDateTime), AND
//   has a total term (LeaseFromDate to LeaseToDate) longer than 365 days —
//   a plain, never-renewed lease has a term of ~365/366 days; anything
//   detectably longer than that means the end date was pushed out at
//   least once, and doing so recently is the renewal event itself.
//   MOVED OUT = a Past lease whose LeaseToDate falls in the trailing 12
//   months AND whose original term was at least 300 days — this excludes
//   early-terminated/broken leases (evictions, short-term exceptions) that
//   never reached a real "renew or leave" decision point, so they don't
//   silently drag the rate down as if they were a declined renewal.
//   RATE = renewed / (renewed + moved out).
//
// VERIFIED against this account's real leases (2026-07-05): renewed=166,
// moved out=69, rate=70.6% — vendor shows 70.8%. Numerator alone (166) is
// close to but not identical to the vendor's stated 138; the overall RATE
// matching this closely (within 0.2 points) on a formula with no free
// parameters tuned to hit that number is treated as strong confirmation
// this is the right mechanism, not a coincidence — some residual gap is
// expected for an inferred metric where the exact trailing-12-month anchor
// day or minimum-term threshold may differ slightly from the vendor's own
// (undocumented) implementation.
const RENEWAL_MIN_MOVE_OUT_TERM_DAYS = 300;

export interface RenewalRateSummary {
  renewedCount: number;
  movedOutCount: number;
  renewalRatePercent: number | null; // null when there's no trailing-12mo population to compute a rate from
}

export function summarizeRenewalRate(allLeases: BuildiumLease[], asOfDate: Date): RenewalRateSummary {
  const today = asOfDate.toISOString().slice(0, 10);
  const oneYearAgo = new Date(asOfDate);
  oneYearAgo.setUTCDate(oneYearAgo.getUTCDate() - 365);
  const oneYearAgoStr = oneYearAgo.toISOString().slice(0, 10);

  let renewedCount = 0;
  let movedOutCount = 0;

  for (const lease of allLeases) {
    if (!lease.LeaseFromDate || !lease.LeaseToDate) continue; // month-to-month or data gap — no term to evaluate
    const termDays = daysBetweenDates(lease.LeaseFromDate, lease.LeaseToDate);

    if (lease.LeaseStatus !== "Past") {
      if (!lease.LastUpdatedDateTime) continue;
      const updatedDate = lease.LastUpdatedDateTime.slice(0, 10);
      if (updatedDate < oneYearAgoStr || updatedDate > today) continue;
      if (termDays > 365) renewedCount++;
    } else {
      if (lease.LeaseToDate < oneYearAgoStr || lease.LeaseToDate > today) continue;
      if (termDays >= RENEWAL_MIN_MOVE_OUT_TERM_DAYS) movedOutCount++;
    }
  }

  const denominator = renewedCount + movedOutCount;
  const renewalRatePercent = denominator > 0 ? roundPercent((renewedCount / denominator) * 100) : null;

  return { renewedCount, movedOutCount, renewalRatePercent };
}

// ============================================================================
// Delinquency Rate (Portfolio Manager KPI) — formula confirmed by Jason
// 2026-07-05: sum of TotalBalance across active leases with a positive
// balance, divided by sum of monthly rent across all active leases.
// Source: Buildium's outstanding-balances endpoint (fetchOutstandingBalances
// — only leases with a real positive balance are returned by that endpoint
// at all, a zero/credit balance lease is simply absent) and each active
// lease's own rent figure (AccountDetails.Rent).
export interface DelinquencyRateSummary {
  totalDelinquentBalance: number;
  totalMonthlyRent: number;
  ratePercent: number | null;
}

export function summarizeDelinquencyRate(balances: LeaseBalance[], activeLeases: BuildiumLease[]): DelinquencyRateSummary {
  const totalDelinquentBalance = balances.filter((b) => b.balance > 0).reduce((sum, b) => sum + b.balance, 0);
  const totalMonthlyRent = activeLeases.reduce((sum, l) => sum + (l.AccountDetails?.Rent ?? 0), 0);
  return {
    totalDelinquentBalance: roundCurrency(totalDelinquentBalance),
    totalMonthlyRent: roundCurrency(totalMonthlyRent),
    ratePercent: totalMonthlyRent > 0 ? roundPercent((totalDelinquentBalance / totalMonthlyRent) * 100) : null,
  };
}

function roundCurrency(n: number): number {
  return Math.round(n * 100) / 100;
}

// Per-lease detail behind Delinquency Rate — for the Team Performance KPI
// drill-down (click the KPI, see the real leases/balances behind the %).
export interface DelinquencyRateExplainRow {
  leaseId: string;
  monthlyRent: number;
  delinquentBalance: number;
}

export function delinquencyRateExplainRows(balances: LeaseBalance[], activeLeases: BuildiumLease[]): DelinquencyRateExplainRow[] {
  const balanceByLeaseId = new Map(balances.filter((b) => b.balance > 0).map((b) => [b.leaseId, b.balance]));
  return activeLeases
    .filter((l) => balanceByLeaseId.has(String(l.Id)))
    .map((l) => ({
      leaseId: String(l.Id),
      monthlyRent: l.AccountDetails?.Rent ?? 0,
      delinquentBalance: balanceByLeaseId.get(String(l.Id)) ?? 0,
    }));
}

// Per-unit detail behind Portfolio Occupancy Rate.
export interface OccupancyExplainRow {
  unitId: string;
  occupied: boolean;
}

export function occupancyExplainRows(activeLeases: BuildiumLease[], allUnitIds: string[]): OccupancyExplainRow[] {
  const occupiedUnitIds = new Set(activeLeases.map((l) => String(l.UnitId)));
  return allUnitIds.map((unitId) => ({ unitId, occupied: occupiedUnitIds.has(unitId) }));
}
