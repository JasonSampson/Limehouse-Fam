import type { BuildiumLease, BuildiumLeaseTransaction } from "../buildium/client.js";

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

// ============================================================================
// KNOWN WRONG METRIC, 2026-07-04 — NOT FIXED, DO NOT TRUST
// avgSecurityDepositWithheldPercent BELOW. Do not remove this notice until
// this is actually rebuilt and re-verified live.
// ============================================================================
// Found comparing "Avg SD Withheld %" against the real vendor site: this
// dashboard showed 111.5% (impossible — a % of deposit withheld cannot
// exceed 100% as a portfolio average), vendor showed 57%.
//
// ROOT CAUSE: this isn't an arithmetic bug, it's the WRONG METRIC.
// avgSecurityDepositWithheldPercent below computes
// avgSecurityDepositWithheld / avgRentPerLease — i.e. "security deposit
// as a percent of rent." But "% withheld" is a real property-management
// term meaning something entirely different: of the deposits collected
// from tenants who have MOVED OUT, what percentage was kept (for damages
// /unpaid charges) versus refunded. That requires move-out deposit
// disposition data — Buildium exposes this as itemized ledger
// charges/credits against the security deposit liability account on a
// lease's transaction history AFTER move-out (confirmed via Buildium's
// own help docs: "Withhold tenant deposits" / "refund or withhold
// security deposits held by a rental owner" — full or partial withhold,
// each posted as ledger transactions, not a single field). There is no
// single "amount withheld" field anywhere in the Buildium lease record —
// AccountDetails.SecurityDeposit (used below) is the deposit HELD on an
// active lease, not withheld at move-out; those are different tenants,
// different leases (Past, not Active), and different data entirely.
//
// This needs a real spec, not a quick patch: (1) fetch Past leases with a
// recent move-out date, (2) fetch each one's transaction history, (3)
// identify which transactions represent a security-deposit deduction vs.
// a refund, (4) sum withheld amounts and sum total deposits originally
// collected for that same set of leases, (5) portfolio % = sum(withheld)
// / sum(total deposits) — NOT an average of per-lease percentages, and
// NOT deposit-as-%-of-rent. Left exactly as-is per Jason's/the
// coordinator's direction on 2026-07-04 rather than shipping a half-fix.
// Next session: start here with Oracle before writing any code.
export interface RentSecurityDepositSummary {
  avgRentPerLease: number | null; // null when there are no leases with a known rent amount
  avgSecurityDepositWithheld: number | null;
  avgSecurityDepositWithheldPercent: number | null; // WRONG METRIC — see notice above. Currently avg SD / avg rent, as a percent; does not represent deposit actually withheld at move-out.
}

export function summarizeRentAndDeposit(leases: BuildiumLease[]): RentSecurityDepositSummary {
  const rents = leases.map((l) => l.AccountDetails?.Rent).filter((v): v is number => typeof v === "number");
  const deposits = leases
    .map((l) => l.AccountDetails?.SecurityDeposit)
    .filter((v): v is number => typeof v === "number");

  const avgRentPerLease = rents.length > 0 ? roundCurrency(average(rents)) : null;
  const avgSecurityDepositWithheld = deposits.length > 0 ? roundCurrency(average(deposits)) : null;
  const avgSecurityDepositWithheldPercent =
    avgRentPerLease !== null && avgSecurityDepositWithheld !== null && avgRentPerLease > 0
      ? roundPercent((avgSecurityDepositWithheld / avgRentPerLease) * 100)
      : null;

  return { avgRentPerLease, avgSecurityDepositWithheld, avgSecurityDepositWithheldPercent };
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
}

export interface LeasePaymentForMonth {
  leaseId: string;
  month: string; // "YYYY-MM" — the rent-due month this payment is being credited against
  paymentDate: string | null; // "YYYY-MM-DD" of the first Payment transaction that month; null if unpaid that month
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
// convention). KNOWN RESIDUAL GAP, not fixed here: this can still MISS
// leases that were active earlier in the window but have since moved out
// (only currently-Active leases are ever passed in) — closing that fully
// would mean also fetching Past leases, a bigger change left as a
// follow-up rather than folded into this fix.
export function buildDuePerMonth(
  leases: Array<{ Id: number | string; LeaseFromDate: string | null }>,
  monthsInWindow: string[]
): Array<{ leaseId: string; month: string }> {
  return leases.flatMap((lease) =>
    monthsInWindow
      .filter((month) => !lease.LeaseFromDate || lease.LeaseFromDate.slice(0, 7) <= month)
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

  const byMonth = new Map<string, { total: number; byThird: number; byTenth: number }>();

  for (const due of duePerMonth) {
    const bucket = byMonth.get(due.month) ?? { total: 0, byThird: 0, byTenth: 0 };
    bucket.total += 1;

    // No balance record at all means Buildium never posted a charge for
    // this lease this month — treated as fully unpaid (an unknown amount
    // owed), same as the old "no matching payment record" behavior.
    const balance = balanceByLeaseMonth.get(`${due.leaseId}|${due.month}`);
    const balanceByThird = balance ? balance.balanceByThird : Infinity;
    const balanceByTenth = balance ? balance.balanceByTenth : Infinity;

    if (balanceByThird <= LATE_BALANCE_THRESHOLD) bucket.byThird += 1;
    if (balanceByTenth <= LATE_BALANCE_THRESHOLD) bucket.byTenth += 1;

    byMonth.set(due.month, bucket);
  }

  return [...byMonth.entries()]
    .map(([month, { total, byThird, byTenth }]) => ({
      month,
      totalLeasesDue: total,
      paidByThirdCount: byThird,
      paidByThirdPercent: total > 0 ? roundPercent((byThird / total) * 100) : 0,
      paidByTenthCount: byTenth,
      paidByTenthPercent: total > 0 ? roundPercent((byTenth / total) * 100) : 0,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// ============================================================================
// FIXED 2026-07-04, per Oracle's real-data reconciliation research —
// REPLACES earliestPaymentPerMonth below (kept only as a reference/fallback,
// not called anywhere anymore). CONFIRMED LIVE against real leases: the old
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

export interface LeaseBalanceForMonth {
  leaseId: string;
  month: string; // "YYYY-MM"
  balanceByThird: number; // amount still owed as of this lease's "by 3rd" cutoff (day 3, unless overridden — see LATE_CUTOFF_DAY_OVERRIDE_BY_LEASE_ID), oldest charge first
  balanceByTenth: number; // amount still owed as of the 10th — always day 10, the grace-period override only ever affects the earlier cutoff
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
  }));
}

// SUPERSEDED 2026-07-07 in the live pipeline by resolveLeaseBalancesPerMonth
// above — kept for reference/tests, not called from syncRoutes.ts anymore.
// Drop-in replacement for the old earliestPaymentPerMonth's call shape, so
// syncRoutes.ts only needs a one-line swap. Only returns rows for months
// that actually had a charge on this lease (a month with no charge at all
// isn't "unpaid," it's simply not applicable — buildDuePerMonth's own
// LeaseFromDate filtering already handles which months a lease is
// considered due for, this just reports what's known from the ledger).
export function resolvePaymentDatesPerMonth(leaseId: string, transactions: BuildiumLeaseTransaction[]): LeasePaymentForMonth[] {
  const resolved = resolveRentPaymentDates(transactions);
  return [...resolved.entries()].map(([month, paymentDate]) => ({ leaseId, month, paymentDate }));
}

// SUPERSEDED 2026-07-04 — kept only for reference/comparison, not called
// anywhere. Only recognized a same-month "Payment" transaction as proof of
// payment, which missed every prepaying and partial-paying tenant. See
// resolveRentPaymentDates above for the real fix.
export function earliestPaymentPerMonth(leaseId: string, transactions: BuildiumLeaseTransaction[]): LeasePaymentForMonth[] {
  const earliestByMonth = new Map<string, string>();
  for (const t of transactions) {
    if (t.TransactionType !== "Payment") continue;
    const month = t.Date.slice(0, 7);
    const existing = earliestByMonth.get(month);
    if (!existing || t.Date < existing) {
      earliestByMonth.set(month, t.Date);
    }
  }
  return [...earliestByMonth.entries()].map(([month, paymentDate]) => ({ leaseId, month, paymentDate }));
}

// ============================================================================
// Avg SD Withheld % — REBUILT 2026-07-04, per Oracle's real-data research.
// This is a DIFFERENT metric from avgSecurityDepositWithheld/
// avgRentPerLease above (which describe deposits currently HELD on Active
// leases) — "% withheld" means, of tenants who have actually MOVED OUT,
// what share of their deposit was kept for damages/unpaid charges versus
// refunded. Operates on Past leases + their transaction history, not
// Active leases + AccountDetails.
//
// CONFIRMED LIVE real transaction types: "Applied Deposit" = amount
// withheld at move-out (negative TotalAmount); "Refund" = amount returned
// to the tenant (positive TotalAmount). Classify by TransactionType
// string, NOT by GL account name — the GL account used varies
// inconsistently ("Move Out Repairs"/"Vendor Over Site/Setup Charge" for
// withholdings; "Rent Income" or "Other Income" for refunds, confirmed
// live on different leases) — the opposite of how the rent-payment fix
// above classifies (GL account name, since Payment/Charge repeat across
// every category and can't be told apart by TransactionType alone).
//
// CRITICAL, confirmed live: roughly a third of recent Past leases have
// NEITHER an Applied Deposit nor a Refund transaction at all — the move-
// out settlement hasn't been processed in Buildium yet. These must be
// EXCLUDED from both the numerator and denominator entirely, not counted
// as 0% withheld (that would misrepresent an unsettled case as "fully
// refunded" and drag the portfolio average down for no real reason).
export interface SecurityDepositWithheldSummary {
  avgSecurityDepositWithheldPercent: number | null; // sum(withheld) / sum(deposit) across SETTLED leases only — a ratio of sums, not an average of per-lease percentages
  settledLeaseCount: number;
  unsettledLeaseCount: number; // leases excluded because Buildium shows no disposition transaction yet
}

export interface PastLeaseDeposit {
  leaseId: string;
  securityDeposit: number | null;
}

// Per-lease withheld/refunded amounts, derived from that lease's raw
// transactions. hasDisposition=false means neither an Applied Deposit nor
// a Refund transaction exists yet — the caller must exclude this lease
// from the portfolio calculation rather than treating it as 0% withheld.
export interface LeaseDepositDisposition {
  leaseId: string;
  withheld: number;
  refunded: number;
  hasDisposition: boolean;
}

export function extractDepositDisposition(leaseId: string, transactions: BuildiumLeaseTransaction[]): LeaseDepositDisposition {
  let withheld = 0;
  let refunded = 0;
  let hasDisposition = false;

  for (const t of transactions) {
    if (t.TransactionType === "Applied Deposit") {
      withheld += Math.abs(t.TotalAmount);
      hasDisposition = true;
    } else if (t.TransactionType === "Refund") {
      refunded += Math.abs(t.TotalAmount);
      hasDisposition = true;
    }
  }

  return { leaseId, withheld: roundCurrency(withheld), refunded: roundCurrency(refunded), hasDisposition };
}

// Portfolio % = sum(withheld) / sum(deposit) across settled leases only —
// per Oracle's spec, explicitly NOT an average of each lease's own
// percentage (that would let a handful of small-deposit leases with
// extreme percentages skew the portfolio number unfairly).
export function summarizeSecurityDepositWithheld(
  deposits: PastLeaseDeposit[],
  dispositions: LeaseDepositDisposition[]
): SecurityDepositWithheldSummary {
  const depositByLeaseId = new Map(deposits.map((d) => [d.leaseId, d.securityDeposit]));

  let sumWithheld = 0;
  let sumDeposit = 0;
  let settledLeaseCount = 0;
  let unsettledLeaseCount = 0;

  for (const disposition of dispositions) {
    if (!disposition.hasDisposition) {
      unsettledLeaseCount++;
      continue;
    }
    const deposit = depositByLeaseId.get(disposition.leaseId);
    if (typeof deposit !== "number") continue; // no known deposit amount for this lease — can't include it in either sum
    sumWithheld += disposition.withheld;
    sumDeposit += deposit;
    settledLeaseCount++;
  }

  const avgSecurityDepositWithheldPercent = sumDeposit > 0 ? roundPercent((sumWithheld / sumDeposit) * 100) : null;

  return { avgSecurityDepositWithheldPercent, settledLeaseCount, unsettledLeaseCount };
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function roundCurrency(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundPercent(n: number): number {
  return Math.round(n * 10) / 10;
}
