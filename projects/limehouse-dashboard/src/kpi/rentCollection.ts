import type { BuildiumLease, BuildiumLeaseTransaction } from "../buildium/client.js";
import { roundPercent, roundCurrency } from "../lib/rounding.js";

// Dashboard tab Financials section: Avg Rent/Lease, Avg SD Withheld, Avg SD
// Withheld %, and the Rent Collection — 12 months chart (% paid by the 3rd
// vs. by the 10th, monthly). Computed from BuildiumLease.AccountDetails.Rent
// / AccountDetails.SecurityDeposit — CONFIRMED LIVE 2026-07-03 against
// Jason's real Buildium account (first real credentials for this project).
// The originally-guessed CurrentRent.Amount/SecurityDeposit.Amount nested
// shape did not exist on the real response at all, which is why
// /api/dashboard/financials/rent-and-deposit always returned all-null —
// every lease silently had zero matching rent/deposit values to average.
// The MATH here is fully unit-tested against fixed fixtures.

// FIXED 2026-07-10 — the WRONG METRIC flagged 2026-07-04 is now rebuilt
// below (see the "Avg SD Withheld" section further down this file) and this
// function no longer computes avgSecurityDepositWithheld/Percent at all.
// The old version averaged AccountDetails.SecurityDeposit across ACTIVE
// leases — the deposit currently HELD, not withheld at move-out — which is
// a fundamentally different population (Active vs. recently-moved-out Past
// leases) and a fundamentally different number (what's held today vs. what
// was kept after move-out). Comparing against the real vendor site 2026-07-04
// showed this dashboard reporting 111.5% (impossible — a portfolio % of
// deposit withheld cannot exceed 100%) against the vendor's real 57%,
// confirming it wasn't a rounding/arithmetic bug but the wrong question
// entirely. See summarizeSecurityDepositWithheld below for the real
// calculation, built from actual move-out reconciliation transactions.
export interface RentSecurityDepositSummary {
  avgRentPerLease: number | null; // null when there are no leases with a known rent amount
}

export function summarizeRentAndDeposit(leases: BuildiumLease[]): RentSecurityDepositSummary {
  const rents = leases.map((l) => l.AccountDetails?.Rent).filter((v): v is number => typeof v === "number");
  const avgRentPerLease = rents.length > 0 ? roundCurrency(average(rents)) : null;
  return { avgRentPerLease };
}

// ============================================================================
// Rent Collection — 12 months chart: % of leases whose rent payment posted
// by the 3rd vs. by the 10th of the month, per calendar month.
// ============================================================================
export interface MonthlyCollectionRate {
  month: string; // "YYYY-MM"
  totalLeasesDue: number;
  paidByThirdCount: number;
  paidByThirdPercent: number;
  paidByTenthCount: number;
  paidByTenthPercent: number;
  // ADDED 2026-07-09, per Jason directly: a THIRD cutoff — the last
  // calendar day of the month — for the new "Rent Collected by Month End"
  // side panels next to the existing chart. Same $200-balance-threshold
  // methodology as paidByThird/paidByTenth above, just a later cutoff date.
  // Deliberately does NOT apply LATE_CUTOFF_DAY_OVERRIDE_BY_LEASE_ID — that
  // override exists for the EARLY cutoff only (a grace period through the
  // 5th instead of the 3rd); by month's end any such grace period has
  // already passed for every lease, so there's nothing to override here.
  paidByMonthEndCount: number;
  paidByMonthEndPercent: number;
}

// Trailing 12 calendar months ending at (and including) asOf's month,
// formatted "YYYY-MM", oldest first.
export function last12Months(asOf: Date): string[] {
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

// ADDED 2026-07-09, per Jason directly: the new "Rent Collected by Month
// End" side panels (a same-month-last-year callout and a by-year list)
// need more history than the trailing-12-month window last12Months gives
// the existing chart — a full prior year for the same-month comparison,
// plus multiple complete years for the yearly rollup. Returns every month
// from January of (asOf's year minus yearsBack) through asOf's own month,
// oldest first — a SUPERSET of last12Months, not a replacement. The
// existing chart keeps using only the most recent 12 of whatever this
// produces (see renderRentCollectionChart's slice in dashboard.js), so its
// own behavior is unchanged even though the underlying sync now fetches a
// wider window.
export function monthsSinceYearsAgo(asOf: Date, yearsBack: number): string[] {
  const months: string[] = [];
  const startYear = asOf.getUTCFullYear() - yearsBack;
  const cursor = new Date(Date.UTC(startYear, 0, 1));
  const end = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  while (cursor.getTime() <= end.getTime()) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

// FIXED 2026-07-04: the current calendar month can't have reached day 10
// yet unless asOf's date-of-month is already past the 10th, which made
// paidByThirdPercent and paidByTenthPercent trivially IDENTICAL for it
// whenever a sync runs before day 10 (every payment recorded so far
// necessarily falls on day <=3, since day 4-10 hasn't happened yet).
// CONFIRMED LIVE 2026-07-04: a sync run on 2026-07-03 produced July
// paidByThirdCount === paidByTenthCount === 128 (53.3% = 53.3%) for
// exactly this reason — not a comparison-logic bug, a still-in-progress
// month being treated as if it were complete. Dropping the current month
// means the "latest month" tile (and this chart's last data point)
// always reflects the most recently FULLY ELAPSED month.
export function excludeCurrentInProgressMonth(months: string[], asOf: Date): string[] {
  const currentMonth = `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, "0")}`;
  return months.filter((m) => m !== currentMonth);
}

// ADDED 2026-07-28, per Jason directly: fetchAllLeases() returns every
// lease in the account's ENTIRE history (Active + Past + Future), not just
// ones relevant to a 2-year window — for an account with years of
// operating history, that's a lot of leases whose transactions would be
// fetched (one Buildium call each) for nothing, since they'd contribute
// zero rows to buildDuePerMonth's output anyway (a Past lease that ended
// long before the window, or a Future lease that hasn't started within
// it, can never satisfy that function's own from/to bounds for any month
// in monthsInWindow). This is the SAME overlap test buildDuePerMonth
// applies per-month, done once per lease instead, so callers can skip the
// transaction fetch entirely for a lease that could never appear in the
// result — correctness is unchanged either way, this only trims wasted work.
export function leaseOverlapsWindow(
  lease: { LeaseFromDate: string | null; LeaseToDate?: string | null },
  monthsInWindow: string[]
): boolean {
  if (monthsInWindow.length === 0) return false;
  const windowStart = monthsInWindow[0];
  const windowEnd = monthsInWindow[monthsInWindow.length - 1];
  const startsInTimeOrBefore = !lease.LeaseFromDate || lease.LeaseFromDate.slice(0, 7) <= windowEnd;
  const endsInTimeOrAfter = !lease.LeaseToDate || lease.LeaseToDate.slice(0, 7) >= windowStart;
  return startsInTimeOrBefore && endsInTimeOrAfter;
}

// Builds the (lease, month) "due" pairs for summarizeMonthlyCollectionRates'
// denominator, restricted to months a lease actually existed in.
//
// FIXED 2026-07-04: the caller used to treat every currently-Active lease
// as due in EVERY month of the trailing-12 window, even months before
// that lease started. CONFIRMED LIVE against Jason's real account: only
// 174 of 240 currently-Active leases actually existed as of 2025-08 (the
// oldest month in a window run 2026-07-03), yet all 240 were counted as
// due that month — inflating the denominator and dragging every month's
// paid-by-3rd/10th percentage down (e.g. June showed 50.8%/57.9% here vs
// the vendor's real 91.8%/96.6%). A lease only counts as due in a month
// if its LeaseFromDate is on or before that month (leases with no
// LeaseFromDate on record are treated as always-due rather than silently
// dropped, matching this file's existing "don't guess, don't hide gaps"
// convention).
//
// CLOSED 2026-07-28, per Jason directly, for the Rent Collection chart's
// year-over-year rebuild: last year's calendar months need leases that
// have SINCE moved out too (only currently-Active leases were ever passed
// in before), so the caller now passes fetchAllLeases()'s wider set
// (Active + Past + Future — see src/buildium/client.ts). That introduces a
// NEW risk this function didn't have to guard against before: a Past
// lease's LeaseFromDate alone would make it count as "due" in every month
// through the end of the window, including months AFTER it actually moved
// out. LeaseToDate now caps the upper end the same way LeaseFromDate caps
// the lower end — a lease with no LeaseToDate on record (e.g. a real
// Active lease with no end date) is treated as always-due going forward,
// same "don't guess, don't hide gaps" treatment as the missing-LeaseFromDate
// case already got.
export function buildDuePerMonth(
  leases: Array<{ Id: number | string; LeaseFromDate: string | null; LeaseToDate?: string | null }>,
  monthsInWindow: string[]
): Array<{ leaseId: string; month: string }> {
  return leases.flatMap((lease) =>
    monthsInWindow
      .filter((month) => !lease.LeaseFromDate || lease.LeaseFromDate.slice(0, 7) <= month)
      .filter((month) => !lease.LeaseToDate || month <= lease.LeaseToDate.slice(0, 7))
      .map((month) => ({ leaseId: String(lease.Id), month }))
  );
}

// `duePerMonth` is the set of (lease, month) pairs where rent was owed —
// i.e. the denominator ("totalLeasesDue"). `balances` is each lease's
// remaining balance as of the 3rd/10th (see resolveLeaseBalancesPerMonth).
// REBUILT 2026-07-07: a lease counts as paid-by-3rd/10th once its balance as
// of that date is $200 or less (LATE_BALANCE_THRESHOLD), not only when it's
// paid in full — see the constant's comment for why. Kept as two separate
// plain-array inputs (rather than this function reaching into Buildium
// client types directly) so it's testable with small fixed fixtures.
export function summarizeMonthlyCollectionRates(
  duePerMonth: Array<{ leaseId: string; month: string }>,
  balances: LeaseBalanceForMonth[]
): MonthlyCollectionRate[] {
  const balanceByLeaseMonth = new Map<string, LeaseBalanceForMonth>();
  for (const b of balances) {
    balanceByLeaseMonth.set(`${b.leaseId}|${b.month}`, b);
  }

  const byMonth = new Map<string, { total: number; byThird: number; byTenth: number; byMonthEnd: number }>();

  for (const due of duePerMonth) {
    const bucket = byMonth.get(due.month) ?? { total: 0, byThird: 0, byTenth: 0, byMonthEnd: 0 };
    bucket.total += 1;

    // No balance record at all means Buildium never posted a charge for
    // this lease this month — treated as fully unpaid (an unknown amount
    // owed), same as the old "no matching payment record" behavior.
    const balance = balanceByLeaseMonth.get(`${due.leaseId}|${due.month}`);
    const balanceByThird = balance ? balance.balanceByThird : Infinity;
    const balanceByTenth = balance ? balance.balanceByTenth : Infinity;
    const balanceByMonthEnd = balance ? balance.balanceByMonthEnd : Infinity;

    if (balanceByThird <= LATE_BALANCE_THRESHOLD) bucket.byThird += 1;
    if (balanceByTenth <= LATE_BALANCE_THRESHOLD) bucket.byTenth += 1;
    if (balanceByMonthEnd <= LATE_BALANCE_THRESHOLD) bucket.byMonthEnd += 1;

    byMonth.set(due.month, bucket);
  }

  return [...byMonth.entries()]
    .map(([month, { total, byThird, byTenth, byMonthEnd }]) => ({
      month,
      totalLeasesDue: total,
      paidByThirdCount: byThird,
      paidByThirdPercent: total > 0 ? roundPercent((byThird / total) * 100) : 0,
      paidByTenthCount: byTenth,
      paidByTenthPercent: total > 0 ? roundPercent((byTenth / total) * 100) : 0,
      paidByMonthEndCount: byMonthEnd,
      paidByMonthEndPercent: total > 0 ? roundPercent((byMonthEnd / total) * 100) : 0,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// ============================================================================
// ADDED 2026-07-09, per Jason directly: the "Rent Collected by Month End"
// side panels next to the existing 12-month chart. Two pieces — a by-year
// rollup list, and a same-calendar-month-last-year callout — both built
// from the SAME wider monthly dataset summarizeMonthlyCollectionRates
// already produces once fed a wider month window (see monthsSinceYearsAgo
// above), not a separate calculation.
// ============================================================================

export interface YearlyCollectionRate {
  year: string; // "YYYY"
  totalLeasesDue: number;
  paidByMonthEndCount: number;
  paidByMonthEndPercent: number;
  monthsIncluded: number; // 12 for a complete past year; fewer for the current year, which is naturally year-to-date since the current in-progress month is already excluded upstream
  lastMonth: string; // "YYYY-MM" — the most recent month included in this year's rollup. ADDED 2026-07-09 per Jason directly, so the side panel can show e.g. "Jun 2026" instead of a bare "2026" for a year-to-date figure.
}

// Rolls the by-month-end figure up to one number per calendar year, e.g.
// "2025: 99.3%". A ratio of SUMS across the year's months (total
// paid-by-month-end lease-months over total due lease-months), not an
// average of each month's percentage — this portfolio has grown from
// ~137 to ~200+ leases across the window this can cover, and averaging
// percentages would let an early, smaller month count exactly as much as
// a later, bigger one, which isn't the right answer for "how did the
// whole year go."
export function summarizeYearlyCollectionRates(months: MonthlyCollectionRate[]): YearlyCollectionRate[] {
  const byYear = new Map<string, { total: number; paid: number; monthsIncluded: number; lastMonth: string }>();

  for (const m of months) {
    const year = m.month.slice(0, 4);
    const bucket = byYear.get(year) ?? { total: 0, paid: 0, monthsIncluded: 0, lastMonth: m.month };
    bucket.total += m.totalLeasesDue;
    bucket.paid += m.paidByMonthEndCount;
    bucket.monthsIncluded += 1;
    if (m.month > bucket.lastMonth) bucket.lastMonth = m.month;
    byYear.set(year, bucket);
  }

  return [...byYear.entries()]
    .map(([year, { total, paid, monthsIncluded, lastMonth }]) => ({
      year,
      totalLeasesDue: total,
      paidByMonthEndCount: paid,
      paidByMonthEndPercent: total > 0 ? roundPercent((paid / total) * 100) : 0,
      monthsIncluded,
      lastMonth,
    }))
    .sort((a, b) => b.year.localeCompare(a.year)); // most recent year first, matching Jason's own example ("2025 99.3%, 2024 99.8%")
}

export interface SameMonthLastYear {
  month: string; // this year's month, e.g. "2026-06"
  lastYearMonth: string; // e.g. "2025-06"
  lastYearPercent: number;
}

// For whatever the latest available month is (normally the dashboard's own
// most-recently-fully-elapsed month), looks up the SAME calendar month one
// year earlier and returns its paid-by-month-end percent — e.g. latestMonth
// "2026-06" looks up "2025-06". Returns null if that earlier month isn't
// present in the data at all, either because the sync's window doesn't
// reach back that far or no lease had a charge that month.
export function findSameMonthLastYear(months: MonthlyCollectionRate[], latestMonth: string): SameMonthLastYear | null {
  const [year, mm] = latestMonth.split("-");
  const lastYearMonth = `${Number(year) - 1}-${mm}`;
  const match = months.find((m) => m.month === lastYearMonth);
  if (!match) return null;
  return { month: latestMonth, lastYearMonth, lastYearPercent: match.paidByMonthEndPercent };
}

// ============================================================================
// FIXED 2026-07-04, per Oracle's real-data reconciliation research —
// replaces an earlier same-month-only rule (deleted 2026-07-30, long
// superseded). CONFIRMED LIVE against real leases: the old
// "same-month Payment transaction" rule missed every tenant who pays early
// (Applied Prepayment pattern) or pays in several partial installments,
// which is why Rent By 3rd/10th read 53.3%/53.3% against the vendor's real
// 91.8%/96.6%.
//
// THE FIX: restrict to the Rent Income (GL account id 3) sub-ledger only —
// ignore every other GL account (fees, deposits, credits) entirely — and
// run a standard FIFO cash-application model: oldest unpaid month's charge
// gets satisfied by the oldest available credit(s) first, in date order,
// regardless of whether a credit was posted before or after the charge it
// ends up covering. This one mechanism correctly handles every real pattern
// Oracle found:
//   - Prepayment (Applied Prepayment transactions, always dated the 1st of
//     the target month): the credit's own date already satisfies "paid by
//     the 3rd" without needing to trace back to the earlier real cash-
//     receipt date against the separate "Prepayments" GL clearing account —
//     day 1 is <=3 either way, so that extra trace-back doesn't change the
//     answer for THIS metric (it would matter for a "how many days early"
//     stat, which isn't what's being computed here).
//   - Direct early payment (a Payment transaction with a Rent Income line,
//     dated in the PRIOR month, no Prepayments GL involved at all): FIFO
//     naturally applies that earlier credit to the oldest open charge,
//     which is the correct month, using the payment's own (earlier) date.
//   - Split/partial payment across several days: the charge isn't
//     "resolved" until enough credits accumulate to cover it; the
//     resolution date is the date of whichever credit was the last one
//     needed, not the first partial payment.
//   - Genuinely unpaid/delinquent: no credit ever arrives to cover the
//     charge, resolution stays null.
//   - Chronic multi-month backlog: FIFO applies new credits to the OLDEST
//     unpaid charge first, matching how real accounting/PM systems apply
//     rent payments — a tenant behind from a prior month has new payments
//     go to that older balance before the current month, which can
//     correctly leave the current month showing unpaid even though a
//     payment was received.
//
// Reversed Payment transactions are NOT specially cased — a proper
// reversal's Journal.Lines are the mirror image of the original payment's
// (this is how double-entry bookkeeping keeps itself balanced), so summing
// signed Rent Income amounts in date order already cancels a reversed
// payment out against its own reversal automatically. This wasn't tested
// against a real reversed-payment fixture (none of the confirmed test
// leases have one) — worth a dedicated live check if a future comparison
// against the vendor site shows a lease with a reversal behaving oddly.
export const RENT_INCOME_GL_ACCOUNT_ID = 3;
const ZERO_EPSILON = 0.005; // guards against floating-point residue after repeated subtraction, not a real-money threshold

// ADDED 2026-07-07, per Jason directly: "Rent By 3rd/10th" isn't "did this
// lease pay in full" — it's "is this lease still meaningfully behind."
// Jason has been tracking this by hand since Aug 2025 (3rd) / Sep 2025
// (10th) and only counts a lease as late once the amount still owed as of
// the cutoff exceeds $200 — a tenant short $20-$75 isn't "late" for this
// metric. Confirmed against his real spreadsheet: our old fully-paid-or-not
// check was flagging 8-20 MORE leases as late than his real counts every
// month, and the gap was almost entirely on the 3rd-day figure (the 10th-day
// figure already lined up closely) — consistent with small balances
// clearing between day 3 and day 10.
export const LATE_BALANCE_THRESHOLD = 200;

// ADDED 2026-07-07, per Jason directly: a handful of INHERITED leases (taken
// over from a previous management company) run on their own late-fee grace
// period instead of Limehouse's standard "late after the 3rd" policy — e.g.
// this one is genuinely not late until after the 5th. Buildium doesn't
// expose this per-lease policy through its API at all (confirmed twice: no
// field on the lease record, nothing on the recurring-transactions endpoint,
// and Buildium's own docs describe it as a lease-level UI setting only —
// see the "Late fee policy report" for the closest thing to an export).
// Inferring it from historical late-fee CHARGE dates in the ledger was
// tried and REJECTED 2026-07-07: an NSF-bounced payment re-triggers a late
// fee charge dated whenever the bounce was processed, which has nothing to
// do with the lease's real grace period and produced false positives for
// several genuinely-standard leases. Until Jason finds a reliable source
// (checking each lease's Late Fee Policy tab, or that report, by hand),
// this is a small manually-confirmed list — same pattern as
// DOOR_COUNT_ANCHORS_BY_YEAR in churn.ts. Add to it as more are confirmed.
export const LATE_CUTOFF_DAY_OVERRIDE_BY_LEASE_ID: Record<string, number> = {
  "2819658": 5, // 3631 Chase Court — confirmed live by Jason 2026-07-07
};

const DEFAULT_LATE_CUTOFF_DAY = 3;

interface RentChargeUnit {
  month: string; // "YYYY-MM"
  amount: number;
}

interface RentCreditUnit {
  date: string; // "YYYY-MM-DD"
  amount: number; // always positive — the absolute value of a Rent Income credit
}

function extractRentLedgerUnits(transactions: BuildiumLeaseTransaction[]): {
  charges: RentChargeUnit[];
  credits: RentCreditUnit[];
} {
  const chargesByMonth = new Map<string, number>();
  const credits: RentCreditUnit[] = [];

  for (const t of transactions) {
    const glRentAmount = (t.Journal?.Lines ?? [])
      .filter((l) => l.GLAccount.Id === RENT_INCOME_GL_ACCOUNT_ID)
      .reduce((sum, l) => sum + l.Amount, 0);
    if (Math.abs(glRentAmount) < ZERO_EPSILON) continue;

    if (glRentAmount > 0) {
      const month = t.Date.slice(0, 7);
      chargesByMonth.set(month, (chargesByMonth.get(month) ?? 0) + glRentAmount);
    } else {
      credits.push({ date: t.Date, amount: -glRentAmount });
    }
  }

  const charges = [...chargesByMonth.entries()]
    .map(([month, amount]) => ({ month, amount }))
    .sort((a, b) => a.month.localeCompare(b.month));
  credits.sort((a, b) => a.date.localeCompare(b.date));

  return { charges, credits };
}

// FIFO cash application over the Rent-Income-only ledger. Returns the
// resolution date for each month that has a charge — the date of the last
// credit needed to fully satisfy that month's charge, or null if never
// fully covered by the credits available. Charges are resolved oldest
// month first; a given credit can only be spent once, partially or fully,
// before moving to the next credit in date order.
export function resolveRentPaymentDates(transactions: BuildiumLeaseTransaction[]): Map<string, string | null> {
  const { charges, credits } = extractRentLedgerUnits(transactions);
  const result = new Map<string, string | null>();

  let creditIndex = 0;
  let creditRemaining = credits.length > 0 ? credits[0].amount : 0;

  for (const charge of charges) {
    let remainingToCover = charge.amount;
    let resolutionDate: string | null = null;

    while (remainingToCover > ZERO_EPSILON && creditIndex < credits.length) {
      const take = Math.min(remainingToCover, creditRemaining);
      remainingToCover -= take;
      creditRemaining -= take;
      resolutionDate = credits[creditIndex].date;

      if (creditRemaining <= ZERO_EPSILON) {
        creditIndex++;
        creditRemaining = creditIndex < credits.length ? credits[creditIndex].amount : 0;
      }
    }

    result.set(charge.month, remainingToCover <= ZERO_EPSILON ? resolutionDate : null);
  }

  return result;
}

// ============================================================================
// REBUILT 2026-07-07, per Jason directly: replaces resolveRentPaymentDates'
// role in the live pipeline (that function's binary "ever fully resolved"
// answer isn't what the $200-late-threshold rule needs — see
// LATE_BALANCE_THRESHOLD above). This answers "how much is still owed for
// THIS month's charge, counting only credits dated on or before asOfDate" —
// the same FIFO oldest-charge-first application, just capped at a point in
// time instead of run to completion.
//
// CONFIRMED against a real NSF bounce (lease 2066996, 4513 Indies Court,
// flagged live by Jason): tenant's July rent (charge, GL 3, +1790) was paid
// in full on 7/1 (credit -1790), then that same payment bounced — Buildium
// records the bounce as a "Reversed Payment" transaction whose Journal.Lines
// mirror the original payment (here: +1790 on GL 3, dated 7/6). Because
// extractRentLedgerUnits classifies any POSITIVE Rent Income line as a
// charge regardless of TransactionType, the reversal is automatically
// folded back into July's total charge amount (1790 + 1790 = 3580) — the
// original 7/1 credit is still only enough to cover half of that, so the
// balance as of any cutoff on/after 7/6 correctly reads $1790 owed again, no
// special-casing needed. If a real replacement payment posts later (say
// 7/8), it becomes a second credit and the balance as of any cutoff on/after
// 7/8 correctly drops back to $0 — this is what lets a bounced-then-repaid
// tenant end up "late" for a cutoff between the bounce and the repayment,
// and "not late" for a cutoff after, matching Jason's own description:
// "what may not have shown up on the 3rd, may show up on the 6th."
function outstandingBalanceAsOf(
  charges: RentChargeUnit[],
  credits: RentCreditUnit[],
  targetMonth: string,
  asOfDate: string
): number {
  const eligibleCredits = credits.filter((c) => c.date <= asOfDate);

  let creditIndex = 0;
  let creditRemaining = eligibleCredits.length > 0 ? eligibleCredits[0].amount : 0;

  for (const charge of charges) {
    let remainingToCover = charge.amount;

    while (remainingToCover > ZERO_EPSILON && creditIndex < eligibleCredits.length) {
      const take = Math.min(remainingToCover, creditRemaining);
      remainingToCover -= take;
      creditRemaining -= take;

      if (creditRemaining <= ZERO_EPSILON) {
        creditIndex++;
        creditRemaining = creditIndex < eligibleCredits.length ? eligibleCredits[creditIndex].amount : 0;
      }
    }

    if (charge.month === targetMonth) {
      return Math.max(0, remainingToCover);
    }
  }

  return 0; // targetMonth had no charge on this lease at all — nothing to owe
}

// Last calendar day of a "YYYY-MM" month, as "YYYY-MM-DD" — day 0 of the
// NEXT month is always the last day of THIS month, a standard trick for
// getting a correct answer across 28/29/30/31-day months (including leap
// Februaries) without a lookup table.
export function lastDayOfMonth(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

export interface LeaseBalanceForMonth {
  leaseId: string;
  month: string; // "YYYY-MM"
  balanceByThird: number; // amount still owed as of this lease's "by 3rd" cutoff (day 3, unless overridden — see LATE_CUTOFF_DAY_OVERRIDE_BY_LEASE_ID), oldest charge first
  balanceByTenth: number; // amount still owed as of the 10th — always day 10, the grace-period override only ever affects the earlier cutoff
  balanceByMonthEnd: number; // amount still owed as of the last calendar day of the month — never overridden, see the field's own note on MonthlyCollectionRate
}

export function resolveLeaseBalancesPerMonth(leaseId: string, transactions: BuildiumLeaseTransaction[]): LeaseBalanceForMonth[] {
  const { charges, credits } = extractRentLedgerUnits(transactions);
  const thirdCutoffDay = LATE_CUTOFF_DAY_OVERRIDE_BY_LEASE_ID[leaseId] ?? DEFAULT_LATE_CUTOFF_DAY;
  const thirdCutoffDayStr = String(thirdCutoffDay).padStart(2, "0");
  return charges.map((charge) => ({
    leaseId,
    month: charge.month,
    balanceByThird: outstandingBalanceAsOf(charges, credits, charge.month, `${charge.month}-${thirdCutoffDayStr}`),
    balanceByTenth: outstandingBalanceAsOf(charges, credits, charge.month, `${charge.month}-10`),
    balanceByMonthEnd: outstandingBalanceAsOf(charges, credits, charge.month, lastDayOfMonth(charge.month)),
  }));
}

// DELETED 2026-07-30 (per Jason directly, per Judge's code-quality
// review): resolvePaymentDatesPerMonth and earliestPaymentPerMonth used to
// live here, both already SUPERSEDED and unused by any live route —
// resolvePaymentDatesPerMonth (2026-07-07) was a drop-in-shaped wrapper
// around resolveRentPaymentDates for a syncRoutes.ts caller that no
// longer exists; earliestPaymentPerMonth (2026-07-04) only recognized a
// same-month "Payment" transaction as proof of payment, which missed
// every prepaying and partial-paying tenant — resolveRentPaymentDates
// below is the real fix.

// ============================================================================
// Avg SD Withheld / Avg SD Withheld % — REBUILT 2026-07-10, per Jason
// directly, by reading the vendor's own drill-down note on their live site
// (a rare case where the vendor documents its exact methodology in-product)
// and cross-checking it against real Buildium data for a known match
// (lease 2540300, 2421 Arkansas Avenue — vendor shows $2,450/$2,450/100%
// for this exact move-out, confirmed live).
//
// The 2026-07-04 rebuild attempt (kept only in git history now) was closer
// in SPIRIT than the original "% of rent" bug, but still didn't match the
// vendor for three concrete reasons the vendor's own note spells out:
//
//   1. WRONG TRANSACTION FILTER. Not every "Applied Deposit" transaction
//      is a real move-out reconciliation — Buildium also uses that same
//      TransactionType for monthly prepayment applications, which have
//      nothing to do with security deposits. The real reconciliation entry
//      always carries a Journal.Memo containing "deposit applied to
//      balances" (confirmed live in two casings: "Deposit applied to
//      balances" and "Security Deposit applied to balances" — both are
//      genuine move-out withholdings, so the filter is a case-insensitive
//      SUBSTRING match, not an exact string). The old code accepted any
//      "Applied Deposit" transaction regardless of memo.
//   2. NO CAP. A withheld amount can never exceed the deposit actually
//      collected — the old code never enforced this, so a data-entry
//      oddity in Buildium could silently inflate the portfolio numerator.
//   3. WRONG WINDOW. The old code used "trailing 12 months of LeaseToDate"
//      ending TODAY. The vendor's real window is move-outs from 13 months
//      ago through 30 days ago — Limehouse doesn't post the reconciliation
//      until roughly 30 days after a tenant moves out, so anything more
//      recent than that is real but not yet reconciled, and including it
//      would misrepresent "not done yet" as "$0 withheld."
//
// Also confirmed live: the vendor's dollar figure ($1,203) is a plain
// AVERAGE of each qualifying lease's (capped) withheld amount — NOT a
// ratio of sums. The percent figure (57%) IS a ratio of sums
// (sum(withheld)/sum(deposit)) — same "don't let a few extreme small-
// deposit leases skew the portfolio number" reasoning the 2026-07-04
// attempt already had right, just applied to the correct population.
// Verified by hand-summing the vendor's own real 34-row list: average
// withheld = $1,203.3 ≈ $1,203; sum(withheld)/sum(deposit) = 57.49% ≈ 57%.
//
// Leases with NO qualifying memo-matched Applied Deposit transaction at
// all are excluded entirely (not counted as $0/0%) — per the vendor's own
// stated rule, this includes a lease that was fully refunded with no
// withholding, not just ones still pending reconciliation.
export interface MoveOutWindow {
  start: string; // "YYYY-MM-DD" — 13 months before asOf
  end: string; // "YYYY-MM-DD" — 30 days before asOf
}

export function securityDepositMoveOutWindow(asOf: Date): MoveOutWindow {
  const start = new Date(asOf);
  start.setUTCMonth(start.getUTCMonth() - 13);
  const end = new Date(asOf);
  end.setUTCDate(end.getUTCDate() - 30);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// Case-insensitive SUBSTRING match, not exact — catches both real-world
// memo variants ("Deposit applied to balances" and "Security Deposit
// applied to balances") without also matching an unrelated memo that
// happens to share other words.
const SD_RECONCILIATION_MEMO_SUBSTRING = "deposit applied to balances";

export interface LeaseDepositWithheld {
  leaseId: string;
  withheld: number; // sum of |TotalAmount| across every qualifying transaction — NOT yet capped at the lease's own deposit; the caller applies the cap once it knows that amount
  hasQualifyingEntry: boolean; // false = no real move-out reconciliation posted yet (or ever, e.g. a fully-refunded lease) — caller must exclude, not treat as $0
}

export function extractSecurityDepositWithheld(leaseId: string, transactions: BuildiumLeaseTransaction[]): LeaseDepositWithheld {
  let withheld = 0;
  let hasQualifyingEntry = false;

  for (const t of transactions) {
    if (t.TransactionType !== "Applied Deposit") continue;
    const memo = t.Journal?.Memo?.toLowerCase() ?? "";
    if (!memo.includes(SD_RECONCILIATION_MEMO_SUBSTRING)) continue; // excludes the OTHER "Applied Deposit" use (monthly prepayment application)
    withheld += Math.abs(t.TotalAmount);
    hasQualifyingEntry = true;
  }

  return { leaseId, withheld: roundCurrency(withheld), hasQualifyingEntry };
}

export interface SecurityDepositWithheldSummary {
  avgSecurityDepositWithheld: number | null; // plain average of each qualifying lease's (capped) withheld amount
  avgSecurityDepositWithheldPercent: number | null; // sum(withheld) / sum(deposit) across qualifying leases — a ratio of sums, not an average of per-lease percentages
  reconciledLeaseCount: number;
}

// Takes the SAME rows the drill-down table shows (see
// securityDepositWithheldRows in leaseRows.ts) — one source of truth for
// both the tile's headline numbers and the list underneath it, rather than
// two separate calculations that could quietly drift apart.
export function summarizeSecurityDepositWithheld(
  rows: Array<{ withheld: number; securityDeposit: number }>
): SecurityDepositWithheldSummary {
  if (rows.length === 0) {
    return { avgSecurityDepositWithheld: null, avgSecurityDepositWithheldPercent: null, reconciledLeaseCount: 0 };
  }

  const sumWithheld = rows.reduce((sum, r) => sum + r.withheld, 0);
  const sumDeposit = rows.reduce((sum, r) => sum + r.securityDeposit, 0);

  return {
    avgSecurityDepositWithheld: roundCurrency(sumWithheld / rows.length),
    avgSecurityDepositWithheldPercent: sumDeposit > 0 ? roundPercent((sumWithheld / sumDeposit) * 100) : null,
    reconciledLeaseCount: rows.length,
  };
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

