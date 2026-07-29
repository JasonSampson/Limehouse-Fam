import type { LeaseBalance } from "./client.js";
import { roundCurrency } from "../lib/rounding.js";

// Delinquency/balance summary logic for the Dashboard and CEO View tabs.
// Deliberately built ONLY on top of fetchOutstandingBalances() (Buildium's
// already-netted "what's actually owed right now" endpoint) — never on a
// sum of /leases/{id}/charges, which is the full historical charge ledger
// and produces numbers unrelated to what's currently owed (confirmed bug in
// late-rent-notices: summing charge history gave $110,044.67 against a real
// $3,115.95 balance, a 35x overstatement). Any future change to this file
// must keep using LeaseBalance.balance (Buildium's own netted TotalBalance)
// as the source of truth, never charge history.
export interface DelinquencySummary {
  totalOutstandingBalance: number;
  delinquentLeaseCount: number;
  evictionPendingCount: number;
  evictionPendingBalance: number;
}

export interface DelinquentLeaseRow {
  leaseId: string;
  propertyId: string;
  balance: number;
  evictionPendingDate: string | null;
}

// Buildium's /leases/outstandingbalances endpoint excludes zero/credit
// balance leases entirely from its response (per its own description) — so
// EVERY row present here is, by construction, already a real positive-or-
// negative balance. "Delinquent" for dashboard purposes means balance > 0
// (money owed to Limehouse); a negative balance is a tenant credit, not
// delinquency, and must not be counted as owed or summed into the
// portfolio's outstanding total as if it were debt.
export function summarizeDelinquency(balances: LeaseBalance[]): DelinquencySummary {
  const owed = balances.filter((b) => b.balance > 0);
  const evictionPending = owed.filter((b) => b.evictionPendingDate !== null);

  return {
    totalOutstandingBalance: roundCurrency(owed.reduce((sum, b) => sum + b.balance, 0)),
    delinquentLeaseCount: owed.length,
    evictionPendingCount: evictionPending.length,
    evictionPendingBalance: roundCurrency(evictionPending.reduce((sum, b) => sum + b.balance, 0)),
  };
}

// Drill-down list shape: property/unit/balance, matching what the vendor
// dashboard's delinquent-leases drill-down already shows (per project
// brief: "same shape as what we captured: property/unit/balance or
// property/unit/rent"). Sorted highest balance first — the most useful
// default ordering for a PM triaging who to call first.
export function delinquentLeaseRows(balances: LeaseBalance[]): DelinquentLeaseRow[] {
  return balances
    .filter((b) => b.balance > 0)
    .map((b) => ({
      leaseId: b.leaseId,
      propertyId: b.propertyId,
      balance: b.balance,
      evictionPendingDate: b.evictionPendingDate,
    }))
    .sort((a, b) => b.balance - a.balance);
}

// ============================================================================
// Delinquency aging buckets (Dashboard tab Financials section)
// ============================================================================
//
// Buckets each delinquent lease's balance by how many days late it is. Kept
// as pure functions over plain inputs (no Date.now(), no direct
// LeaseBalance/BuildiumLease dependency) so this is trivially unit-testable
// with fixed fixtures — the caller (src/kpi/rentCollection.ts) is
// responsible for joining balances to each lease's PaymentDueDay and
// computing "as of today" before calling in here.
export interface AgingBucket {
  label: "0-30" | "31-60" | "61-90" | "90+";
  totalBalance: number;
  leaseCount: number;
}

export interface AgingInput {
  leaseId: string;
  balance: number;
  daysLate: number;
}

// CONFIRMED LIVE 2026-07-06: leaseAgingInputsFromTransactions can return
// MORE THAN ONE AgingInput for a single lease (one per still-open charge,
// once its FIFO total reconciles) — e.g. one lease with a charge in the
// 31-60 bucket and another charge in the 61-90 bucket. leaseCount here
// must count DISTINCT leases per bucket, not input rows, or a handful of
// leases with several open charges inflates the count (62 rows across 4
// buckets for what was really only 15 delinquent leases).
export function bucketDelinquencyByAge(inputs: AgingInput[]): AgingBucket[] {
  const totalsByLabel: Record<AgingBucket["label"], number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  const leaseIdsByLabel: Record<AgingBucket["label"], Set<string>> = {
    "0-30": new Set(),
    "31-60": new Set(),
    "61-90": new Set(),
    "90+": new Set(),
  };

  for (const input of inputs) {
    if (input.balance <= 0) continue; // credits are not delinquency, same rule as summarizeDelinquency
    const label = ageBucketLabel(input.daysLate);
    totalsByLabel[label] = roundCurrency(totalsByLabel[label] + input.balance);
    leaseIdsByLabel[label].add(input.leaseId);
  }

  return (Object.keys(totalsByLabel) as AgingBucket["label"][]).map((label) => ({
    label,
    totalBalance: totalsByLabel[label],
    leaseCount: leaseIdsByLabel[label].size,
  }));
}

function ageBucketLabel(daysLate: number): AgingBucket["label"] {
  if (daysLate <= 30) return "0-30";
  if (daysLate <= 60) return "31-60";
  if (daysLate <= 90) return "61-90";
  return "90+";
}

// ============================================================================
// Real per-charge aging via FIFO ledger walk — REPLACES the PaymentDueDay
// heuristic below for the Dashboard's Delinquency Aging tile.
//
// CONFIRMED LIVE 2026-07-06 against the vendor: daysLateAsOf only ever looks
// at THIS month's or LAST month's due date, so a balance unpaid for 2+
// months still computes as <=30 days late — every dollar landed in the
// "0-30" bucket regardless of real age. The vendor splits the same total
// balance across all four buckets using each dollar's real charge date.
//
// Buildium's real transaction sign convention (confirmed via
// rentCollection.ts's own tests): "Charge" is a positive TotalAmount,
// payments/credits/prepayments are negative. Walking transactions oldest
// to newest and consuming FIFO (oldest unpaid charge gets paid off first)
// reproduces real double-entry aging — this is the same FIFO principle
// underlying any real AR aging report, not a guess.
//
// Safety net from a real prior bug (see file header: summing raw charge
// history overstated a lease's balance 35x in a different project) — this
// does NOT just sum charges. It reconciles the FIFO-derived remaining total
// against Buildium's own trusted TotalBalance for that lease; only when
// they match (within a cent) does the per-charge breakdown get used. A
// mismatch (e.g. transaction history doesn't go back far enough) falls back
// to putting the whole balance in one bucket dated to the oldest open
// charge found, rather than silently reporting a wrong split.
export interface TransactionForAging {
  date: string;
  totalAmount: number; // positive = charge, negative = payment/credit/reduction
}

interface OpenCharge {
  date: string;
  remainingAmount: number;
}

// CONFIRMED LIVE 2026-07-06: a payment that exceeds every currently-open
// charge (a tenant catching up with a lump sum bigger than what was owed at
// that exact moment) used to just vanish once the queue was empty, instead
// of being credited toward whatever charge comes next. That made this FIFO
// walk think old charges were still open when an overpayment had already
// covered them — confirmed against 3 real leases where the leftover
// (unapplied) payment amount exactly explained the gap between this walk's
// total and Buildium's trusted balance. Any excess now carries forward as
// creditBalance and is applied against the next charge(s) before they're
// added to the open-charges queue.
function openChargesFromTransactions(transactions: TransactionForAging[]): OpenCharge[] {
  const sorted = [...transactions].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const queue: OpenCharge[] = [];
  let creditBalance = 0;
  for (const t of sorted) {
    if (t.totalAmount > 0) {
      let remaining = t.totalAmount;
      if (creditBalance > 1e-9) {
        const applied = Math.min(creditBalance, remaining);
        creditBalance -= applied;
        remaining -= applied;
      }
      if (remaining > 1e-9) queue.push({ date: t.date, remainingAmount: remaining });
    } else if (t.totalAmount < 0) {
      let toConsume = -t.totalAmount;
      while (toConsume > 1e-9 && queue.length > 0) {
        const oldest = queue[0];
        const consumed = Math.min(oldest.remainingAmount, toConsume);
        oldest.remainingAmount -= consumed;
        toConsume -= consumed;
        if (oldest.remainingAmount <= 1e-9) queue.shift();
      }
      if (toConsume > 1e-9) creditBalance += toConsume;
    }
  }
  return queue.filter((c) => c.remainingAmount > 1e-9);
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)), 0);
}

// Returns one AgingInput per real open charge for this lease (so the total
// delinquent balance can land in more than one bucket) when the FIFO total
// reconciles with Buildium's own trusted balance; otherwise one AgingInput
// for the whole balance, dated to the oldest open charge (or "not late",
// the least alarming assumption, if no charge history is available at all).
export function leaseAgingInputsFromTransactions(
  leaseId: string,
  realBalance: number,
  transactions: TransactionForAging[],
  asOfDate: Date
): AgingInput[] {
  if (realBalance <= 0) return []; // not delinquent, same rule as bucketDelinquencyByAge

  const openCharges = openChargesFromTransactions(transactions);
  const fifoTotal = roundCurrency(openCharges.reduce((sum, c) => sum + c.remainingAmount, 0));
  const reconciled = Math.abs(fifoTotal - realBalance) < 0.01;

  if (reconciled && openCharges.length > 0) {
    return openCharges.map((c) => ({
      leaseId,
      balance: roundCurrency(c.remainingAmount),
      daysLate: daysBetween(new Date(c.date), asOfDate),
    }));
  }

  const oldest = openCharges[0] ?? null;
  return [
    {
      leaseId,
      balance: realBalance,
      daysLate: oldest ? daysBetween(new Date(oldest.date), asOfDate) : 0,
    },
  ];
}

// Computes days-late for one lease as of a given date, anchored on
// PaymentDueDay (the day-of-month rent is due, already on BuildiumLease).
// If this month's due date hasn't happened yet, the relevant unpaid due
// date was last month's. A null PaymentDueDay (data gap) returns 0 days
// late rather than throwing — a balance with an unknown due date lands in
// the safest ("0-30", least alarming) bucket instead of crashing the whole
// aging report.
export function daysLateAsOf(paymentDueDay: number | null, asOfDate: Date): number {
  if (paymentDueDay === null) return 0;

  const year = asOfDate.getUTCFullYear();
  const month = asOfDate.getUTCMonth();
  const today = asOfDate.getUTCDate();

  let dueDate = new Date(Date.UTC(year, month, paymentDueDay));
  if (paymentDueDay > today) {
    dueDate = new Date(Date.UTC(year, month - 1, paymentDueDay));
  }

  const daysLate = Math.floor((asOfDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(daysLate, 0);
}
