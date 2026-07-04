import type { LeaseBalance } from "./client.js";

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

function roundCurrency(n: number): number {
  return Math.round(n * 100) / 100;
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

export function bucketDelinquencyByAge(inputs: AgingInput[]): AgingBucket[] {
  const buckets: Record<AgingBucket["label"], { totalBalance: number; leaseCount: number }> = {
    "0-30": { totalBalance: 0, leaseCount: 0 },
    "31-60": { totalBalance: 0, leaseCount: 0 },
    "61-90": { totalBalance: 0, leaseCount: 0 },
    "90+": { totalBalance: 0, leaseCount: 0 },
  };

  for (const input of inputs) {
    if (input.balance <= 0) continue; // credits are not delinquency, same rule as summarizeDelinquency
    const label = ageBucketLabel(input.daysLate);
    buckets[label].totalBalance = roundCurrency(buckets[label].totalBalance + input.balance);
    buckets[label].leaseCount += 1;
  }

  return (Object.keys(buckets) as AgingBucket["label"][]).map((label) => ({
    label,
    ...buckets[label],
  }));
}

function ageBucketLabel(daysLate: number): AgingBucket["label"] {
  if (daysLate <= 30) return "0-30";
  if (daysLate <= 60) return "31-60";
  if (daysLate <= 90) return "61-90";
  return "90+";
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
