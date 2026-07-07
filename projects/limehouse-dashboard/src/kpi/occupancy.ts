import type { BuildiumLease, BuildiumUnit, LeaseBalance } from "../buildium/client.js";
import { RENT_INCOME_GL_ACCOUNT_ID } from "./rentCollection.js";

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
// SUPERSEDED 2026-07-07 — the LastUpdatedDateTime+term-length heuristic
// below was a plausible reverse-engineered guess (see the two dead ends
// documented above it, which are still real and still true), but it was
// WRONG about the actual mechanism. Per Jason directly: Buildium tracks
// each lease's real renewal date on its RENT SCHEDULE — visible in
// Buildium's own UI at Tenants > Financials > Rent, or a property's
// Recurring Transactions — not on the lease record's own fields at all.
//
// CONFIRMED LIVE 2026-07-07 against 2 real leases: fetching
// /leases/{id}/recurringtransactions and finding the recurring charge line
// against GL account 3 (Rent Income) with the LATEST FirstOccurrenceDate
// reproduced the vendor's own shown "renewed" date EXACTLY on both —
// including one lease with two Rent entries on file (both IsExpired:false;
// the vendor used the newer one, not the older), and one lease with a
// rent increase already scheduled for a future date the vendor still
// counted as this year's renewal. See mostRecentRentEffectiveDate below.
//
// THE FORMULA:
//   RENEWED = a lease that is NOT currently Past (tenant hasn't left) AND
//   whose most recent Rent-line effective date (mostRecentRentEffectiveDate)
//   falls within the trailing 12 months.
//   MOVED OUT = a Past lease whose LeaseToDate falls in the trailing 12
//   months AND whose original term was at least 300 days — this excludes
//   early-terminated/broken leases (evictions, short-term exceptions) that
//   never reached a real "renew or leave" decision point, so they don't
//   silently drag the rate down as if they were a declined renewal. Kept
//   as-is from the earlier formula — moved-out leases have no forward rent
//   schedule to check, so LeaseToDate is still the only real signal.
//   RATE = renewed / (renewed + moved out).
const RENEWAL_MIN_MOVE_OUT_TERM_DAYS = 300;

// One entry per recurring-transaction line Buildium returns for a lease —
// deliberately a plain, decoupled shape (not BuildiumLeaseRecurringTransaction
// directly) so this stays pure/testable, same pattern as delinquency.ts's
// TransactionForAging.
export interface RentScheduleEntry {
  firstOccurrenceDate: string;
  lineGlAccountIds: number[];
}

export function mostRecentRentEffectiveDate(entries: RentScheduleEntry[]): string | null {
  const rentEntryDates = entries
    .filter((e) => e.lineGlAccountIds.includes(RENT_INCOME_GL_ACCOUNT_ID))
    .map((e) => e.firstOccurrenceDate);
  if (rentEntryDates.length === 0) return null;
  return rentEntryDates.reduce((latest, d) => (d > latest ? d : latest));
}

export interface RenewalRateSummary {
  renewedCount: number;
  movedOutCount: number;
  renewalRatePercent: number | null; // null when there's no trailing-12mo population to compute a rate from
}

export function summarizeRenewalRate(
  allLeases: BuildiumLease[],
  rentEffectiveDateByLeaseId: Map<string, string>,
  asOfDate: Date
): RenewalRateSummary {
  const today = asOfDate.toISOString().slice(0, 10);
  const oneYearAgo = new Date(asOfDate);
  oneYearAgo.setUTCDate(oneYearAgo.getUTCDate() - 365);
  const oneYearAgoStr = oneYearAgo.toISOString().slice(0, 10);

  let renewedCount = 0;
  let movedOutCount = 0;

  // ATTEMPTED 2026-07-07, REVERTED: tried reclassifying a Past lease as
  // renewed when another lease exists on the same unit starting shortly
  // after (a "seamless successor," to catch cases like a lease renewed via
  // a brand-new record instead of extending the old one in place). At a
  // 45-day gap threshold this looked right on 2 hand-checked examples, but
  // at full portfolio scale it matched unrelated leases across different
  // years on the same property (e.g. pairing one lease's 2025 end date
  // with a completely different, later lease's 2026 start that the vendor
  // separately already counted as its own renewal) — renewedCount jumped
  // to 171 and movedOutCount collapsed to 35, both clearly wrong. A bare
  // day-count gap isn't a reliable signal at this scale without also
  // matching on the underlying tenant, which Buildium's lease record
  // doesn't expose in a form this account's data supports. Reverted to the
  // simpler, well-supported term-length floor below — confirmed accurate
  // on the renewed side (137 vs. the vendor's real 138) even though the
  // moved-out side remains this floor-based approximation.
  for (const lease of allLeases) {
    if (lease.LeaseStatus !== "Past") {
      const rentDate = rentEffectiveDateByLeaseId.get(String(lease.Id));
      if (!rentDate) continue;
      // A brand-new lease's very first rent charge ALSO creates a Rent
      // recurring-transaction entry dated to move-in — that's not a
      // renewal, it's day one. A simple "later than LeaseFromDate" check
      // isn't enough: a lease starting mid-month (e.g. LeaseFromDate
      // 2026-08-17) often has its recurring Rent entry's
      // FirstOccurrenceDate rounded to the start of the FOLLOWING month
      // (2026-09-01, since the partial first month is prorated as a
      // one-time charge, not part of the recurring schedule) — a ~2-week
      // gap that "later than" alone can't tell apart from a real renewal.
      // Requiring at least 180 days between move-in and the rent-effective
      // date safely clears any proration quirk while still catching every
      // real renewal (which is always close to a year out).
      if (lease.LeaseFromDate && daysBetweenDates(lease.LeaseFromDate, rentDate) < 180) continue;
      // No upper bound here (unlike the moved-out side below) — CONFIRMED
      // LIVE 2026-07-07: the vendor counts a rent increase already
      // scheduled ahead of time (e.g. entered 2-3 months in advance of its
      // effective date) as this year's renewal even though the date is
      // still in the future.
      if (rentDate < oneYearAgoStr) continue;
      renewedCount++;
      continue;
    }
    if (!lease.LeaseFromDate || !lease.LeaseToDate) continue;
    const termDays = daysBetweenDates(lease.LeaseFromDate, lease.LeaseToDate);
    if (lease.LeaseToDate < oneYearAgoStr || lease.LeaseToDate > today) continue;
    if (termDays >= RENEWAL_MIN_MOVE_OUT_TERM_DAYS) movedOutCount++;
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
