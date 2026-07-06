import { describe, it, expect } from "vitest";
import {
  summarizeRentAndDeposit,
  summarizeMonthlyCollectionRates,
  earliestPaymentPerMonth,
  resolveRentPaymentDates,
  resolvePaymentDatesPerMonth,
  extractDepositDisposition,
  summarizeSecurityDepositWithheld,
  last12Months,
  excludeCurrentInProgressMonth,
  buildDuePerMonth,
  type LeasePaymentForMonth,
  type PastLeaseDeposit,
  type LeaseDepositDisposition,
} from "../../src/kpi/rentCollection.js";
import type { BuildiumLease, BuildiumLeaseTransaction } from "../../src/buildium/client.js";

// Builds a transaction with Journal.Lines, matching the real shape
// confirmed live 2026-07-04 (see client.ts). `glLines` is a shorthand list
// of [glAccountId, glAccountName, amount] tuples — most fixtures below only
// need a single Rent Income line, but the real shape allows several
// (fees/RBP bundled into the same transaction), so this keeps that
// possible without every test needing to spell out the full object.
function txn(
  overrides: Partial<Omit<BuildiumLeaseTransaction, "Journal">> & {
    glLines?: Array<[number, string, number]>;
  }
): BuildiumLeaseTransaction {
  const { glLines, ...rest } = overrides;
  return {
    Id: 1,
    LeaseId: 10,
    Date: "2026-06-01",
    TransactionType: "Charge",
    TotalAmount: 0,
    Journal: glLines
      ? {
          Memo: null,
          Lines: glLines.map(([Id, Name, Amount]) => ({ GLAccount: { Id, Name }, Amount })),
        }
      : undefined,
    ...rest,
  };
}

const RENT_INCOME = 3;
const PREPAYMENTS_GL = 18;

function lease(overrides: Partial<BuildiumLease>): BuildiumLease {
  return {
    Id: 1,
    PropertyId: 1,
    UnitId: 1,
    UnitNumber: "1A",
    LeaseStatus: "Active",
    LeaseType: "Fixed",
    LeaseFromDate: "2026-01-01",
    LeaseToDate: "2026-12-31",
    IsEvictionPending: false,
    PaymentDueDay: 1,
    CurrentTenants: null,
    ...overrides,
  };
}

// Field shape (AccountDetails.Rent / AccountDetails.SecurityDeposit, both
// flat numbers) CONFIRMED LIVE 2026-07-03 against Jason's real Buildium
// account. This replaced an earlier, wrong guess (CurrentRent.Amount /
// SecurityDeposit.Amount nested objects, which don't exist on the real
// response at all) that caused /api/dashboard/financials/rent-and-deposit
// to always return all-null in production.
describe("summarizeRentAndDeposit", () => {
  it("averages rent and security deposit across leases with known amounts", () => {
    const leases = [
      lease({ AccountDetails: { Rent: 1000, SecurityDeposit: 1000 } }),
      lease({ AccountDetails: { Rent: 1500, SecurityDeposit: 750 } }),
    ];
    const result = summarizeRentAndDeposit(leases);
    expect(result.avgRentPerLease).toBe(1250);
    expect(result.avgSecurityDepositWithheld).toBe(875);
    expect(result.avgSecurityDepositWithheldPercent).toBe(70); // 875/1250
  });

  it("skips leases with a missing rent or deposit amount rather than treating them as 0", () => {
    const leases = [
      lease({ AccountDetails: { Rent: 1000, SecurityDeposit: 1000 } }),
      lease({ AccountDetails: { Rent: null, SecurityDeposit: null } }),
    ];
    const result = summarizeRentAndDeposit(leases);
    expect(result.avgRentPerLease).toBe(1000); // not dragged down to 500 by the null
    expect(result.avgSecurityDepositWithheld).toBe(1000);
  });

  it("returns nulls (not NaN/0) when no leases have rent data at all", () => {
    const leases = [lease({ AccountDetails: { Rent: null, SecurityDeposit: null } })];
    const result = summarizeRentAndDeposit(leases);
    expect(result.avgRentPerLease).toBeNull();
    expect(result.avgSecurityDepositWithheld).toBeNull();
    expect(result.avgSecurityDepositWithheldPercent).toBeNull();
  });

  it("handles AccountDetails being entirely absent (optional field, e.g. an older/edge-case lease record)", () => {
    const leases = [lease({})];
    const result = summarizeRentAndDeposit(leases);
    expect(result.avgRentPerLease).toBeNull();
  });

  it("handles AccountDetails being null (some real leases return this instead of omitting the field)", () => {
    const leases = [lease({ AccountDetails: null })];
    const result = summarizeRentAndDeposit(leases);
    expect(result.avgRentPerLease).toBeNull();
  });
});

describe("summarizeMonthlyCollectionRates", () => {
  it("computes paid-by-3rd and paid-by-10th percentages per month", () => {
    const duePerMonth = [
      { leaseId: "1", month: "2026-06" },
      { leaseId: "2", month: "2026-06" },
      { leaseId: "3", month: "2026-06" },
      { leaseId: "4", month: "2026-06" },
    ];
    const payments: LeasePaymentForMonth[] = [
      { leaseId: "1", month: "2026-06", paymentDate: "2026-06-02" }, // by 3rd and by 10th
      { leaseId: "2", month: "2026-06", paymentDate: "2026-06-07" }, // by 10th only
      { leaseId: "3", month: "2026-06", paymentDate: "2026-06-15" }, // neither
      { leaseId: "4", month: "2026-06", paymentDate: null }, // unpaid
    ];
    const result = summarizeMonthlyCollectionRates(duePerMonth, payments);
    expect(result).toEqual([
      {
        month: "2026-06",
        totalLeasesDue: 4,
        paidByThirdCount: 1,
        paidByThirdPercent: 25,
        paidByTenthCount: 2,
        paidByTenthPercent: 50,
      },
    ]);
  });

  it("treats a lease with no matching payment record as unpaid, not a crash", () => {
    const duePerMonth = [{ leaseId: "1", month: "2026-06" }];
    const result = summarizeMonthlyCollectionRates(duePerMonth, []);
    expect(result[0].paidByThirdCount).toBe(0);
    expect(result[0].paidByTenthCount).toBe(0);
  });

  it("sorts multiple months chronologically", () => {
    const duePerMonth = [
      { leaseId: "1", month: "2026-07" },
      { leaseId: "1", month: "2026-05" },
      { leaseId: "1", month: "2026-06" },
    ];
    const result = summarizeMonthlyCollectionRates(duePerMonth, []);
    expect(result.map((r) => r.month)).toEqual(["2026-05", "2026-06", "2026-07"]);
  });

  it("boundary: day 3 counts as paid-by-3rd, day 10 counts as paid-by-10th", () => {
    const duePerMonth = [
      { leaseId: "1", month: "2026-06" },
      { leaseId: "2", month: "2026-06" },
    ];
    const payments: LeasePaymentForMonth[] = [
      { leaseId: "1", month: "2026-06", paymentDate: "2026-06-03" },
      { leaseId: "2", month: "2026-06", paymentDate: "2026-06-10" },
    ];
    const result = summarizeMonthlyCollectionRates(duePerMonth, payments);
    expect(result[0].paidByThirdCount).toBe(1); // only the day-3 payment
    expect(result[0].paidByTenthCount).toBe(2); // both day-3 and day-10 are <=10
  });
});

describe("last12Months", () => {
  it("returns 12 months ending at asOf's month, oldest first", () => {
    const result = last12Months(new Date("2026-07-03T00:00:00Z"));
    expect(result).toEqual([
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
    ]);
  });
});

// Regression test for the real bug found 2026-07-04 comparing against the
// vendor site: a sync run partway through July produced identical
// paidByThird/paidByTenth counts for July (128 == 128, 53.3% == 53.3%)
// because every July payment recorded so far necessarily fell on day
// <=3 — day 10 hadn't happened yet. Excluding the still-in-progress
// current month fixes this.
describe("excludeCurrentInProgressMonth", () => {
  it("drops the current month from the window", () => {
    const months = last12Months(new Date("2026-07-03T00:00:00Z"));
    const result = excludeCurrentInProgressMonth(months, new Date("2026-07-03T00:00:00Z"));
    expect(result).not.toContain("2026-07");
    expect(result[result.length - 1]).toBe("2026-06");
    expect(result).toHaveLength(11);
  });

  it("does nothing if the current month isn't in the list", () => {
    const result = excludeCurrentInProgressMonth(["2026-01", "2026-02"], new Date("2026-07-03T00:00:00Z"));
    expect(result).toEqual(["2026-01", "2026-02"]);
  });
});

// Regression test for the real bug found 2026-07-04 comparing against the
// vendor site: a lease that started AFTER a given month was still counted
// as "due" that month, inflating the denominator (confirmed live: only
// 174 of 240 real currently-Active leases existed as of 2025-08, but the
// old code counted all 240 as due that far back) and dragging every
// month's paid-by-3rd/10th percentage down.
describe("buildDuePerMonth", () => {
  it("only counts a lease as due in months on or after its LeaseFromDate", () => {
    const leases = [
      { Id: 1, LeaseFromDate: "2026-03-15" }, // started mid-March
      { Id: 2, LeaseFromDate: "2025-01-01" }, // started well before the window
    ];
    const months = ["2026-01", "2026-02", "2026-03", "2026-04"];
    const result = buildDuePerMonth(leases, months);
    // lease 1 should NOT appear for 2026-01 or 2026-02 (didn't exist yet)
    expect(result.filter((d) => d.leaseId === "1").map((d) => d.month)).toEqual(["2026-03", "2026-04"]);
    // lease 2 existed the whole window
    expect(result.filter((d) => d.leaseId === "2").map((d) => d.month)).toEqual(months);
  });

  it("treats a missing LeaseFromDate as always-due rather than dropping it silently", () => {
    const leases = [{ Id: 1, LeaseFromDate: null }];
    const months = ["2026-01", "2026-02"];
    const result = buildDuePerMonth(leases, months);
    expect(result).toEqual([
      { leaseId: "1", month: "2026-01" },
      { leaseId: "1", month: "2026-02" },
    ]);
  });

  it("matches on year-month only, ignoring day-of-month on LeaseFromDate", () => {
    const leases = [{ Id: 1, LeaseFromDate: "2026-03-31" }]; // last day of March still counts as "existed in March"
    const result = buildDuePerMonth(leases, ["2026-03"]);
    expect(result).toEqual([{ leaseId: "1", month: "2026-03" }]);
  });
});

describe("earliestPaymentPerMonth", () => {
  it("picks the earliest Payment transaction per month, ignoring non-Payment types", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      { Id: 1, LeaseId: 10, Date: "2026-06-15", TransactionType: "Charge", TotalAmount: 1000 },
      { Id: 2, LeaseId: 10, Date: "2026-06-08", TransactionType: "Payment", TotalAmount: 1000 },
      { Id: 3, LeaseId: 10, Date: "2026-06-02", TransactionType: "Payment", TotalAmount: 1000 },
    ];
    const result = earliestPaymentPerMonth("10", transactions);
    expect(result).toEqual([{ leaseId: "10", month: "2026-06", paymentDate: "2026-06-02" }]);
  });

  it("returns separate entries for separate months", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      { Id: 1, LeaseId: 10, Date: "2026-05-05", TransactionType: "Payment", TotalAmount: 1000 },
      { Id: 2, LeaseId: 10, Date: "2026-06-05", TransactionType: "Payment", TotalAmount: 1000 },
    ];
    const result = earliestPaymentPerMonth("10", transactions);
    expect(result).toHaveLength(2);
  });

  it("returns an empty array when there are no Payment transactions", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      { Id: 1, LeaseId: 10, Date: "2026-06-15", TransactionType: "Charge", TotalAmount: 1000 },
    ];
    expect(earliestPaymentPerMonth("10", transactions)).toEqual([]);
  });
});

// ============================================================================
// resolveRentPaymentDates — the FIXED 2026-07-04 replacement for
// earliestPaymentPerMonth above. Fixtures modeled on Oracle's real,
// hand-verified leases (real IDs referenced in comments for traceability;
// verified live against the actual leases with these exact outcomes before
// this was wired into the sync route).
// ============================================================================
describe("resolveRentPaymentDates", () => {
  // Modeled on real lease 2706563: tenant pays early via Buildium's
  // "Prepayments" GL clearing-account mechanism. The actual cash-receipt
  // Payment (against GL 18, NOT Rent Income) never appears in the
  // Rent-Income-only ledger at all — only the "Applied Prepayment"
  // transaction does, dated the 1st of the target month. Expected: paid by
  // the 3rd (day 1).
  it("Pattern A — Applied Prepayment against GL 'Prepayments', resolves to the 1st", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-05-31", TransactionType: "Payment", TotalAmount: -1600, glLines: [[PREPAYMENTS_GL, "Prepayments", -1600]] }),
      txn({ Id: 2, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1600, glLines: [[RENT_INCOME, "Rent Income", 1600]] }),
      txn({ Id: 3, Date: "2026-06-01", TransactionType: "Applied Prepayment", TotalAmount: -1600, glLines: [[RENT_INCOME, "Rent Income", -1600]] }),
    ];
    const result = resolveRentPaymentDates(transactions);
    expect(result.get("2026-06")).toBe("2026-06-01");
  });

  // Modeled on real lease 1737132: tenant pays on the 1st, no prepayment
  // mechanism involved at all. Expected: paid by the 3rd.
  it("on-time direct payment resolves to its own date", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1500, glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-06-01", TransactionType: "Payment", TotalAmount: -1500, glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    expect(resolveRentPaymentDates(transactions).get("2026-06")).toBe("2026-06-01");
  });

  // Modeled on real lease 2687264: paid on the 5th — not by the 3rd, but by
  // the 10th.
  it("a late direct payment resolves to its real (late) date", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1500, glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-06-05", TransactionType: "Payment", TotalAmount: -1500, glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    expect(resolveRentPaymentDates(transactions).get("2026-06")).toBe("2026-06-05");
  });

  // Modeled on real lease 2624547: chronic partial payer — the charge
  // isn't fully covered until the LAST of several partial payments spread
  // across more than a week. Resolution date must be the date the balance
  // actually clears, not the first partial payment.
  it("a charge split across several partial payments resolves to the date the LAST piece clears it", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1000, glLines: [[RENT_INCOME, "Rent Income", 1000]] }),
      txn({ Id: 2, Date: "2026-06-03", TransactionType: "Payment", TotalAmount: -300, glLines: [[RENT_INCOME, "Rent Income", -300]] }),
      txn({ Id: 3, Date: "2026-06-08", TransactionType: "Payment", TotalAmount: -300, glLines: [[RENT_INCOME, "Rent Income", -300]] }),
      txn({ Id: 4, Date: "2026-06-12", TransactionType: "Payment", TotalAmount: -400, glLines: [[RENT_INCOME, "Rent Income", -400]] }),
    ];
    const result = resolveRentPaymentDates(transactions);
    expect(result.get("2026-06")).toBe("2026-06-12");
  });

  // Modeled on real lease 2598271: a genuine eviction-in-progress case — no
  // payment ever touches the charge at all. Must resolve to null (unpaid),
  // not a crash or a false date.
  it("a charge with no covering payment at all resolves to null", () => {
    const transactions = [txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1500, glLines: [[RENT_INCOME, "Rent Income", 1500]] })];
    expect(resolveRentPaymentDates(transactions).get("2026-06")).toBeNull();
  });

  it("ignores transactions with no Rent Income journal line at all (fees, deposits, other GL accounts)", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1500, glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-06-01", TransactionType: "Payment", TotalAmount: -1500, glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
      // A same-day fee payment against a totally different GL account — must not affect the Rent Income resolution at all.
      txn({ Id: 3, Date: "2026-06-01", TransactionType: "Payment", TotalAmount: -45.95, glLines: [[958019, "Resident Benefits Package", -45.95]] }),
    ];
    expect(resolveRentPaymentDates(transactions).get("2026-06")).toBe("2026-06-01");
  });

  it("a credit dated before the charge (a true prepayment, no Prepayments GL involved) still resolves correctly via FIFO", () => {
    // Modeled on real lease 2825025's "direct early payment, no Prepayments
    // GL clearing account at all" pattern — the payment itself is dated in
    // the PRIOR month, directly against Rent Income.
    const transactions = [
      txn({ Id: 1, Date: "2026-05-09", TransactionType: "Payment", TotalAmount: -1500, glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
      txn({ Id: 2, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1500, glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
    ];
    expect(resolveRentPaymentDates(transactions).get("2026-06")).toBe("2026-05-09");
  });

  it("handles multiple months independently, oldest charge consuming oldest credit first (FIFO)", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-05-01", TransactionType: "Charge", TotalAmount: 1000, glLines: [[RENT_INCOME, "Rent Income", 1000]] }),
      txn({ Id: 2, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1000, glLines: [[RENT_INCOME, "Rent Income", 1000]] }),
      txn({ Id: 3, Date: "2026-05-02", TransactionType: "Payment", TotalAmount: -1000, glLines: [[RENT_INCOME, "Rent Income", -1000]] }),
      txn({ Id: 4, Date: "2026-06-02", TransactionType: "Payment", TotalAmount: -1000, glLines: [[RENT_INCOME, "Rent Income", -1000]] }),
    ];
    const result = resolveRentPaymentDates(transactions);
    expect(result.get("2026-05")).toBe("2026-05-02");
    expect(result.get("2026-06")).toBe("2026-06-02");
  });
});

describe("resolvePaymentDatesPerMonth", () => {
  it("wraps resolveRentPaymentDates into the LeasePaymentForMonth shape summarizeMonthlyCollectionRates expects", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1500, glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-06-01", TransactionType: "Payment", TotalAmount: -1500, glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    const result = resolvePaymentDatesPerMonth("10", transactions);
    expect(result).toEqual([{ leaseId: "10", month: "2026-06", paymentDate: "2026-06-01" }]);
  });
});

// ============================================================================
// extractDepositDisposition / summarizeSecurityDepositWithheld — NEW
// 2026-07-04. Fixtures modeled on Oracle's 13 real, hand-verified settled
// move-outs plus the confirmed "unsettled, must be excluded" case.
// ============================================================================
describe("extractDepositDisposition", () => {
  // Modeled on real lease 2540300: $2,450 deposit, 100% withheld, no refund.
  it("sums Applied Deposit as withheld and Refund as refunded, by TransactionType not GL account", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      { Id: 1, LeaseId: 1, Date: "2026-02-17", TransactionType: "Charge", TotalAmount: 465 },
      { Id: 2, LeaseId: 1, Date: "2026-02-17", TransactionType: "Applied Deposit", TotalAmount: -2450 },
    ];
    const result = extractDepositDisposition("1", transactions);
    expect(result).toEqual({ leaseId: "1", withheld: 2450, refunded: 0, hasDisposition: true });
  });

  // Modeled on real lease 2589108: mostly withheld, small $0.45 refund.
  it("handles a mix of withheld and refunded on the same lease", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      { Id: 1, LeaseId: 1, Date: "2026-05-06", TransactionType: "Refund", TotalAmount: 0.45 },
      { Id: 2, LeaseId: 1, Date: "2026-05-06", TransactionType: "Applied Deposit", TotalAmount: -1315.72 },
    ];
    const result = extractDepositDisposition("1", transactions);
    expect(result.withheld).toBe(1315.72);
    expect(result.refunded).toBe(0.45);
    expect(result.hasDisposition).toBe(true);
  });

  // Modeled on real lease 2309097: fully refunded, nothing withheld.
  it("handles a fully-refunded move-out (0% withheld)", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      { Id: 1, LeaseId: 1, Date: "2025-08-01", TransactionType: "Refund", TotalAmount: 2200 },
    ];
    const result = extractDepositDisposition("1", transactions);
    expect(result.withheld).toBe(0);
    expect(result.refunded).toBe(2200);
    expect(result.hasDisposition).toBe(true);
  });

  // Modeled on real lease 2363680: a real recent move-out where Buildium
  // shows ordinary rent charges/payments through the move-out month but no
  // Applied Deposit or Refund transaction at all — the settlement simply
  // hasn't been processed yet. Must report hasDisposition:false so the
  // portfolio calculation excludes it, not counts it as 0% withheld.
  it("reports hasDisposition:false when neither Applied Deposit nor Refund exists yet", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      { Id: 1, LeaseId: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1500 },
      { Id: 2, LeaseId: 1, Date: "2026-06-01", TransactionType: "Payment", TotalAmount: -1500 },
    ];
    const result = extractDepositDisposition("1", transactions);
    expect(result.hasDisposition).toBe(false);
    expect(result.withheld).toBe(0);
    expect(result.refunded).toBe(0);
  });
});

describe("summarizeSecurityDepositWithheld", () => {
  it("computes portfolio % as sum(withheld)/sum(deposit), not an average of per-lease percentages", () => {
    // Two leases with very different deposit sizes — an average-of-
    // percentages would treat them equally; sum-of-sums correctly weights
    // the larger deposit more.
    const deposits: PastLeaseDeposit[] = [
      { leaseId: "1", securityDeposit: 1000 },
      { leaseId: "2", securityDeposit: 4000 },
    ];
    const dispositions: LeaseDepositDisposition[] = [
      { leaseId: "1", withheld: 1000, refunded: 0, hasDisposition: true }, // 100%
      { leaseId: "2", withheld: 400, refunded: 3600, hasDisposition: true }, // 10%
    ];
    const result = summarizeSecurityDepositWithheld(deposits, dispositions);
    // sum(withheld)=1400, sum(deposit)=5000 -> 28%, NOT the naive average of (100%+10%)/2=55%
    expect(result.avgSecurityDepositWithheldPercent).toBe(28);
    expect(result.settledLeaseCount).toBe(2);
    expect(result.unsettledLeaseCount).toBe(0);
  });

  it("excludes unsettled leases from both numerator and denominator entirely, not as 0%", () => {
    const deposits: PastLeaseDeposit[] = [
      { leaseId: "1", securityDeposit: 1000 },
      { leaseId: "2", securityDeposit: 2000 }, // unsettled — must not drag the average down as if 0% were withheld
    ];
    const dispositions: LeaseDepositDisposition[] = [
      { leaseId: "1", withheld: 1000, refunded: 0, hasDisposition: true }, // 100%
      { leaseId: "2", withheld: 0, refunded: 0, hasDisposition: false }, // unsettled
    ];
    const result = summarizeSecurityDepositWithheld(deposits, dispositions);
    expect(result.avgSecurityDepositWithheldPercent).toBe(100); // only lease 1 counts, not diluted by lease 2's unsettled $0
    expect(result.settledLeaseCount).toBe(1);
    expect(result.unsettledLeaseCount).toBe(1);
  });

  it("returns null when there are no settled leases with a known deposit amount at all", () => {
    const result = summarizeSecurityDepositWithheld([], []);
    expect(result.avgSecurityDepositWithheldPercent).toBeNull();
    expect(result.settledLeaseCount).toBe(0);
  });

  // Full 13-lease portfolio check, matching Oracle's real hand-computed
  // percentages exactly (verified live against the real leases before
  // being encoded here as fixtures) — this is the same real-money math the
  // vendor site's Avg SD Withheld % tile is being compared against.
  it("matches Oracle's real 13-lease portfolio calculation (42.6%)", () => {
    const deposits: PastLeaseDeposit[] = [
      { leaseId: "2187438", securityDeposit: 1470 },
      { leaseId: "2540300", securityDeposit: 2450 },
      { leaseId: "2513056", securityDeposit: 2700 },
      { leaseId: "2589108", securityDeposit: 1650 },
      { leaseId: "2309216", securityDeposit: 2495 },
      { leaseId: "2500978", securityDeposit: 2025 },
      { leaseId: "2603363", securityDeposit: 3000 },
      { leaseId: "2503700", securityDeposit: 1700 },
      { leaseId: "2287726", securityDeposit: 1535 },
      { leaseId: "2246300", securityDeposit: 1550 },
      { leaseId: "2481322", securityDeposit: 3565 },
      { leaseId: "2651113", securityDeposit: 2925 },
      { leaseId: "2309097", securityDeposit: 4400 },
    ];
    const dispositions: LeaseDepositDisposition[] = [
      { leaseId: "2187438", withheld: 1470, refunded: 0, hasDisposition: true },
      { leaseId: "2540300", withheld: 2450, refunded: 0, hasDisposition: true },
      { leaseId: "2513056", withheld: 2186.55, refunded: 0, hasDisposition: true },
      { leaseId: "2589108", withheld: 1315.72, refunded: 0.45, hasDisposition: true },
      { leaseId: "2309216", withheld: 1558.35, refunded: 0, hasDisposition: true },
      { leaseId: "2500978", withheld: 1075, refunded: 0, hasDisposition: true },
      { leaseId: "2603363", withheld: 1432.2, refunded: 0, hasDisposition: true },
      { leaseId: "2503700", withheld: 800, refunded: 0, hasDisposition: true },
      { leaseId: "2287726", withheld: 375, refunded: 0, hasDisposition: true },
      { leaseId: "2246300", withheld: 242.67, refunded: 0, hasDisposition: true },
      { leaseId: "2481322", withheld: 315, refunded: 50, hasDisposition: true },
      { leaseId: "2651113", withheld: 187.5, refunded: 0, hasDisposition: true },
      { leaseId: "2309097", withheld: 0, refunded: 2200, hasDisposition: true },
    ];
    const result = summarizeSecurityDepositWithheld(deposits, dispositions);
    expect(result.avgSecurityDepositWithheldPercent).toBe(42.6);
    expect(result.settledLeaseCount).toBe(13);
    expect(result.unsettledLeaseCount).toBe(0);
  });
});
