import type { BuildiumLease, BuildiumLeaseTransaction } from "../buildium/client.js";

// Dashboard tab Financials section: Avg Rent/Lease, Avg SD Withheld, Avg SD
// Withheld %, and the Rent Collection — 12 months chart (% paid by the 3rd
// vs. by the 10th, monthly). All computed from BuildiumLease.CurrentRent /
// SecurityDeposit (flagged unverified in src/buildium/client.ts — no live
// Buildium key for this project yet) and BuildiumLeaseTransaction rows
// (also unverified). The MATH here is fully unit-tested against fixed
// fixtures; only the upstream field names/shapes are the open question.

export interface RentSecurityDepositSummary {
  avgRentPerLease: number | null; // null when there are no leases with a known rent amount
  avgSecurityDepositWithheld: number | null;
  avgSecurityDepositWithheldPercent: number | null; // avg SD / avg rent, as a percent
}

export function summarizeRentAndDeposit(leases: BuildiumLease[]): RentSecurityDepositSummary {
  const rents = leases.map((l) => l.CurrentRent?.Amount).filter((v): v is number => typeof v === "number");
  const deposits = leases.map((l) => l.SecurityDeposit?.Amount).filter((v): v is number => typeof v === "number");

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

// `duePerMonth` is the set of (lease, month) pairs where rent was owed —
// i.e. the denominator ("totalLeasesDue"). `payments` is the set of actual
// payment transactions already filtered to TransactionType === "Payment"
// and matched to the month they were applied to. Kept as two separate
// plain-array inputs (rather than this function reaching into Buildium
// client types directly) so it's testable with small fixed fixtures.
export function summarizeMonthlyCollectionRates(
  duePerMonth: Array<{ leaseId: string; month: string }>,
  payments: LeasePaymentForMonth[]
): MonthlyCollectionRate[] {
  const paymentByLeaseMonth = new Map<string, string>(); // "leaseId|month" -> paymentDate
  for (const p of payments) {
    if (p.paymentDate) {
      paymentByLeaseMonth.set(`${p.leaseId}|${p.month}`, p.paymentDate);
    }
  }

  const byMonth = new Map<string, { total: number; byThird: number; byTenth: number }>();

  for (const due of duePerMonth) {
    const bucket = byMonth.get(due.month) ?? { total: 0, byThird: 0, byTenth: 0 };
    bucket.total += 1;

    const paymentDate = paymentByLeaseMonth.get(`${due.leaseId}|${due.month}`);
    if (paymentDate) {
      const dayOfMonth = Number(paymentDate.slice(8, 10));
      if (dayOfMonth <= 3) bucket.byThird += 1;
      if (dayOfMonth <= 10) bucket.byTenth += 1;
    }

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

// Helper for callers wiring real Buildium data: turns a lease's raw
// transactions into the LeasePaymentForMonth shape above by finding the
// EARLIEST Payment transaction posted within each month. Buildium's exact
// TransactionType string for a rent payment is unverified (see client.ts
// research note) — this defaults to matching "Payment" case-sensitively;
// update this filter once a live response confirms the real value.
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

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function roundCurrency(n: number): number {
  return Math.round(n * 100) / 100;
}

function roundPercent(n: number): number {
  return Math.round(n * 10) / 10;
}
