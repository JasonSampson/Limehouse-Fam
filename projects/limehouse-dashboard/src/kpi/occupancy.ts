import type { BuildiumLease, BuildiumUnit, LeaseBalance } from "../buildium/client.js";
import { RENT_INCOME_GL_ACCOUNT_ID, monthsSinceYearsAgo, lastDayOfMonth } from "./rentCollection.js";

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

// Renewals tile (Leasing Pipeline) — REPLACED 2026-07-13, per Jason
// directly: this used to be "leases ending within 60 days" (a forward-
// looking upcoming-expiration count). CONFIRMED LIVE against the vendor
// site that their own "Renewals" tile is NOT that — it's the exact same
// trailing-12-month "already renewed" count as their Renewal Rate tile and
// their "Renewals — Trailing 12 Mo" chart (all three show 140). Jason chose
// to match the vendor's definition exactly rather than keep the 60-day
// view. See renewalRateRows in src/kpi/leaseRows.ts (outcome === "renewed"
// rows) — the Renewals tile now reuses that same cached computation rather
// than a separate live one, so it can never disagree with Renewal Rate's
// own "N renewed" subtext.

function roundPercent(n: number): number {
  return Math.round(n * 10) / 10;
}

// Avg Tenancy moved to src/kpi/tenancy.ts 2026-07-12, per Jason directly —
// rebuilt around every real Buildium tenant (past and current), not just
// today's active leases. See that file for the full derivation.

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

// ============================================================================
// Occupancy Rate — 12 Months chart — REBUILT 2026-07-09, per Jason
// directly: "year over year, for each month, as far back as can be
// tracked." Buildium has no historical daily/monthly snapshot of
// occupancy (unlike the vendor's own version, which only has ~50 days of
// real snapshot history per its own admission elsewhere on this
// dashboard) — but real per-lease LeaseFromDate/LeaseToDate history goes
// back years, which is enough to RECONSTRUCT occupancy for any past
// month: a unit is "occupied" in month M if any lease (regardless of
// current status) covered that month.
//
// The trickier half is the DENOMINATOR — how many units even existed
// under management that far back. Confirmed live 2026-07-09: this
// account's real first-lease dates go back to 2014, ramping up from 11
// units then to 234 today, roughly tracking Jason's own real Jan-1
// door-count anchors (2023: 137 real vs. 142 reconstructed here — a
// small, expected gap). A unit only counts toward a given month's total
// if it has NO lease history at all (never-rented — no evidence it
// joined later, so assumed part of the portfolio all along) OR its
// earliest known lease started on or before that month — so a property
// added in 2024 correctly doesn't drag down 2020's percentage. This is
// scoped to CURRENTLY-tracked units only: a door lost in the past won't
// appear in earlier months either (survivorship — real limitation, not
// hidden).
export interface MonthlyOccupancyRate {
  month: string; // "YYYY-MM"
  occupiedUnits: number;
  totalUnits: number;
  occupancyPercent: number | null; // null when totalUnits is 0 — no trackable units yet that month, not a real 0% (monthsSinceEarliestTrackable pads back to January of the earliest year, which can be a few months before any unit actually existed)
}

// Earliest month we have ANY real lease-coverage evidence for, across the
// given units — the natural start of "as far back as can be tracked."
// Returns null if none of the units has any lease history at all.
export function earliestTrackableMonth(units: BuildiumUnit[], allLeases: BuildiumLease[]): string | null {
  const trackedUnitIds = new Set(units.map((u) => u.Id));
  let earliest: string | null = null;
  for (const l of allLeases) {
    if (!l.LeaseFromDate || !trackedUnitIds.has(l.UnitId)) continue;
    if (earliest === null || l.LeaseFromDate < earliest) earliest = l.LeaseFromDate;
  }
  return earliest ? earliest.slice(0, 7) : null;
}

export function summarizeMonthlyOccupancy(units: BuildiumUnit[], allLeases: BuildiumLease[], months: string[], asOf: Date): MonthlyOccupancyRate[] {
  const leasesByUnit = new Map<number, BuildiumLease[]>();
  for (const l of allLeases) {
    const bucket = leasesByUnit.get(l.UnitId);
    if (bucket) bucket.push(l);
    else leasesByUnit.set(l.UnitId, [l]);
  }

  const firstLeaseDateByUnit = new Map<number, string | null>();
  for (const u of units) {
    const dates = (leasesByUnit.get(u.Id) ?? [])
      .map((l) => l.LeaseFromDate)
      .filter((d): d is string => d !== null)
      .sort();
    firstLeaseDateByUnit.set(u.Id, dates[0] ?? null);
  }

  // CONFIRMED 2026-07-09, per Jason directly: the 10 currently-tracked
  // units with ZERO lease history are all real, recently-added properties
  // that simply haven't been rented yet — not units that have sat vacant
  // since 2014. Projecting them backward through the portfolio's whole
  // history badly deflated early years (a 10-unit vacant drag when the
  // whole portfolio WAS only ~10-20 units). They're only counted from the
  // CURRENT month onward instead — the one month we actually know they're
  // real — not retroactively into years they didn't exist.
  const currentMonth = `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, "0")}`;

  return months.map((month) => {
    const monthStart = `${month}-01`;
    const monthEnd = lastDayOfMonth(month);
    let totalUnits = 0;
    let occupiedUnits = 0;
    for (const u of units) {
      const firstLease = firstLeaseDateByUnit.get(u.Id) ?? null;
      if (firstLease === null) {
        if (month !== currentMonth) continue; // no lease history at all — only count it for the current month, see comment above
      } else if (firstLease > monthEnd) {
        continue; // unit didn't exist under management yet as of this month
      }
      totalUnits++;
      const isOccupied = (leasesByUnit.get(u.Id) ?? []).some(
        (l) => l.LeaseFromDate !== null && l.LeaseFromDate <= monthEnd && (l.LeaseToDate === null || l.LeaseToDate >= monthStart)
      );
      if (isOccupied) occupiedUnits++;
    }
    return { month, occupiedUnits, totalUnits, occupancyPercent: totalUnits > 0 ? roundPercent((occupiedUnits / totalUnits) * 100) : null };
  });
}

// Same idea as monthsSinceYearsAgo, but starting from a specific real
// earliest-trackable month rather than a fixed lookback window.
export function monthsSinceEarliestTrackable(asOf: Date, earliestMonth: string): string[] {
  const yearsBack = asOf.getUTCFullYear() - Number(earliestMonth.slice(0, 4));
  return monthsSinceYearsAgo(asOf, Math.max(yearsBack, 0));
}

export interface YearlyOccupancyRate {
  year: string; // "YYYY"
  occupiedUnitMonths: number;
  totalUnitMonths: number;
  avgOccupancyPercent: number;
  monthsIncluded: number;
  lastMonth: string; // "YYYY-MM" — most recent month included, for a year-to-date label like "Jul 2026"
}

// Rolls monthly occupancy up to one number per calendar year — a ratio of
// SUMS (total occupied unit-months over total tracked unit-months), not
// an average of each month's percentage, for the same reason as
// summarizeYearlyCollectionRates in rentCollection.ts: the portfolio's
// total unit count changed across the window this covers, so an early,
// smaller month shouldn't count exactly as much as a later, bigger one.
export function summarizeYearlyOccupancy(months: MonthlyOccupancyRate[]): YearlyOccupancyRate[] {
  const byYear = new Map<string, { occupied: number; total: number; monthsIncluded: number; lastMonth: string }>();

  for (const m of months) {
    const year = m.month.slice(0, 4);
    const bucket = byYear.get(year) ?? { occupied: 0, total: 0, monthsIncluded: 0, lastMonth: m.month };
    bucket.occupied += m.occupiedUnits;
    bucket.total += m.totalUnits;
    bucket.monthsIncluded += 1;
    if (m.month > bucket.lastMonth) bucket.lastMonth = m.month;
    byYear.set(year, bucket);
  }

  return [...byYear.entries()]
    .map(([year, { occupied, total, monthsIncluded, lastMonth }]) => ({
      year,
      occupiedUnitMonths: occupied,
      totalUnitMonths: total,
      avgOccupancyPercent: total > 0 ? roundPercent((occupied / total) * 100) : 0,
      monthsIncluded,
      lastMonth,
    }))
    .sort((a, b) => b.year.localeCompare(a.year));
}

export interface SameMonthLastYearOccupancy {
  month: string; // this year's month, e.g. "2026-06"
  lastYearMonth: string; // e.g. "2025-06"
  lastYearOccupancyPercent: number | null;
}

export function findSameMonthLastYearOccupancy(months: MonthlyOccupancyRate[], latestMonth: string): SameMonthLastYearOccupancy | null {
  const [year, mm] = latestMonth.split("-");
  const lastYearMonth = `${Number(year) - 1}-${mm}`;
  const match = months.find((m) => m.month === lastYearMonth);
  if (!match) return null;
  return { month: latestMonth, lastYearMonth, lastYearOccupancyPercent: match.occupancyPercent };
}
