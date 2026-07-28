import { describe, it, expect } from "vitest";
import {
  summarizeRentAndDeposit,
  summarizeMonthlyCollectionRates,
  earliestPaymentPerMonth,
  resolveRentPaymentDates,
  resolvePaymentDatesPerMonth,
  resolveLeaseBalancesPerMonth,
  LATE_CUTOFF_DAY_OVERRIDE_BY_LEASE_ID,
  extractSecurityDepositWithheld,
  summarizeSecurityDepositWithheld,
  securityDepositMoveOutWindow,
  last12Months,
  monthsSinceYearsAgo,
  lastDayOfMonth,
  summarizeYearlyCollectionRates,
  findSameMonthLastYear,
  excludeCurrentInProgressMonth,
  buildDuePerMonth,
  leaseOverlapsWindow,
  type LeasePaymentForMonth,
  type LeaseBalanceForMonth,
  type MonthlyCollectionRate,
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
    memo?: string | null;
  }
): BuildiumLeaseTransaction {
  const { glLines, memo, ...rest } = overrides;
  return {
    Id: 1,
    LeaseId: 10,
    Date: "2026-06-01",
    TransactionType: "Charge",
    TotalAmount: 0,
    Journal: glLines || memo !== undefined
      ? {
          Memo: memo ?? null,
          Lines: (glLines ?? []).map(([Id, Name, Amount]) => ({ GLAccount: { Id, Name }, Amount })),
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
    MoveOutData: [],
    Tenants: [],
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
  it("averages rent across leases with a known rent amount", () => {
    const leases = [lease({ AccountDetails: { Rent: 1000, SecurityDeposit: 1000 } }), lease({ AccountDetails: { Rent: 1500, SecurityDeposit: 750 } })];
    const result = summarizeRentAndDeposit(leases);
    expect(result.avgRentPerLease).toBe(1250);
  });

  it("skips leases with a missing rent amount rather than treating them as 0", () => {
    const leases = [lease({ AccountDetails: { Rent: 1000, SecurityDeposit: 1000 } }), lease({ AccountDetails: { Rent: null, SecurityDeposit: null } })];
    const result = summarizeRentAndDeposit(leases);
    expect(result.avgRentPerLease).toBe(1000); // not dragged down to 500 by the null
  });

  it("returns null (not NaN/0) when no leases have rent data at all", () => {
    const leases = [lease({ AccountDetails: { Rent: null, SecurityDeposit: null } })];
    const result = summarizeRentAndDeposit(leases);
    expect(result.avgRentPerLease).toBeNull();
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

function balance(overrides: Partial<LeaseBalanceForMonth>): LeaseBalanceForMonth {
  return { leaseId: "1", month: "2026-06", balanceByThird: 0, balanceByTenth: 0, balanceByMonthEnd: 0, ...overrides };
}

describe("summarizeMonthlyCollectionRates", () => {
  it("computes paid-by-3rd and paid-by-10th percentages per month", () => {
    const duePerMonth = [
      { leaseId: "1", month: "2026-06" },
      { leaseId: "2", month: "2026-06" },
      { leaseId: "3", month: "2026-06" },
      { leaseId: "4", month: "2026-06" },
    ];
    const balances: LeaseBalanceForMonth[] = [
      balance({ leaseId: "1", balanceByThird: 0, balanceByTenth: 0, balanceByMonthEnd: 0 }), // clear by 3rd, 10th, and month end
      balance({ leaseId: "2", balanceByThird: 1200, balanceByTenth: 0, balanceByMonthEnd: 0 }), // clear by 10th and month end only
      balance({ leaseId: "3", balanceByThird: 1200, balanceByTenth: 1200, balanceByMonthEnd: 0 }), // still owes as of 3rd/10th, pays by month end
      balance({ leaseId: "4", balanceByThird: 1200, balanceByTenth: 1200, balanceByMonthEnd: 1200 }), // never pays, even by month end
    ];
    const result = summarizeMonthlyCollectionRates(duePerMonth, balances);
    expect(result).toEqual([
      {
        month: "2026-06",
        totalLeasesDue: 4,
        paidByThirdCount: 1,
        paidByThirdPercent: 25,
        paidByTenthCount: 2,
        paidByTenthPercent: 50,
        paidByMonthEndCount: 3,
        paidByMonthEndPercent: 75,
      },
    ]);
  });

  it("treats a lease with no matching balance record as unpaid, not a crash", () => {
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

  // The $200 rule, straight from Jason: a lease that's short $20-$75 isn't
  // "late" for this metric. Only a remaining balance over $200 counts.
  it("counts a lease as paid once its remaining balance is $200 or less, not only when fully paid", () => {
    const duePerMonth = [
      { leaseId: "1", month: "2026-06" }, // owes $50 as of the 3rd — not late
      { leaseId: "2", month: "2026-06" }, // owes exactly $200 as of the 3rd — boundary, not late
      { leaseId: "3", month: "2026-06" }, // owes $200.01 as of the 3rd — late
    ];
    const balances: LeaseBalanceForMonth[] = [
      balance({ leaseId: "1", balanceByThird: 50 }),
      balance({ leaseId: "2", balanceByThird: 200 }),
      balance({ leaseId: "3", balanceByThird: 200.01 }),
    ];
    const result = summarizeMonthlyCollectionRates(duePerMonth, balances);
    expect(result[0].paidByThirdCount).toBe(2); // leases 1 and 2
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

describe("monthsSinceYearsAgo", () => {
  it("returns every month from January of (asOf's year minus yearsBack) through asOf's own month, oldest first", () => {
    const result = monthsSinceYearsAgo(new Date("2026-07-03T00:00:00Z"), 2);
    expect(result[0]).toBe("2024-01");
    expect(result[result.length - 1]).toBe("2026-07");
    expect(result).toHaveLength(31); // Jan 2024 through Jul 2026 inclusive = 24 + 7 = 31 months
  });

  it("is a superset of last12Months for the same asOf date", () => {
    const asOf = new Date("2026-07-03T00:00:00Z");
    const wide = monthsSinceYearsAgo(asOf, 2);
    const narrow = last12Months(asOf);
    for (const m of narrow) {
      expect(wide).toContain(m);
    }
  });

  it("yearsBack of 0 returns just the current calendar year so far", () => {
    const result = monthsSinceYearsAgo(new Date("2026-03-15T00:00:00Z"), 0);
    expect(result).toEqual(["2026-01", "2026-02", "2026-03"]);
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

  // ADDED 2026-07-28, per Jason directly, for the Rent Collection chart's
  // year-over-year rebuild: fetchAllLeases() (now the real caller) includes
  // Past leases, which have a real LeaseToDate — without this upper bound,
  // a lease that moved out mid-window would still count as due for every
  // month after it left.
  it("only counts a lease as due in months on or before its LeaseToDate", () => {
    const leases = [
      { Id: 1, LeaseFromDate: "2026-01-01", LeaseToDate: "2026-02-20" }, // moved out mid-Feb
      { Id: 2, LeaseFromDate: "2026-01-01", LeaseToDate: null }, // still active, no end date
    ];
    const months = ["2026-01", "2026-02", "2026-03", "2026-04"];
    const result = buildDuePerMonth(leases, months);
    expect(result.filter((d) => d.leaseId === "1").map((d) => d.month)).toEqual(["2026-01", "2026-02"]);
    expect(result.filter((d) => d.leaseId === "2").map((d) => d.month)).toEqual(months);
  });

  it("matches on year-month only, ignoring day-of-month on LeaseToDate", () => {
    const leases = [{ Id: 1, LeaseFromDate: "2026-01-01", LeaseToDate: "2026-03-01" }]; // moved out on the 1st still counts as "existed in March"
    const result = buildDuePerMonth(leases, ["2026-03", "2026-04"]);
    expect(result).toEqual([{ leaseId: "1", month: "2026-03" }]);
  });
});

describe("leaseOverlapsWindow", () => {
  it("keeps a lease whose range overlaps the window", () => {
    const months = ["2026-01", "2026-02", "2026-03"];
    expect(leaseOverlapsWindow({ LeaseFromDate: "2025-06-01", LeaseToDate: "2026-02-15" }, months)).toBe(true);
    expect(leaseOverlapsWindow({ LeaseFromDate: "2026-02-01", LeaseToDate: null }, months)).toBe(true);
  });

  it("drops a lease that ended before the window starts", () => {
    const months = ["2026-01", "2026-02", "2026-03"];
    expect(leaseOverlapsWindow({ LeaseFromDate: "2024-01-01", LeaseToDate: "2025-12-01" }, months)).toBe(false);
  });

  it("drops a Future lease that hasn't started by the window's end", () => {
    const months = ["2026-01", "2026-02", "2026-03"];
    expect(leaseOverlapsWindow({ LeaseFromDate: "2026-04-01", LeaseToDate: null }, months)).toBe(false);
  });

  it("returns false for an empty window", () => {
    expect(leaseOverlapsWindow({ LeaseFromDate: null, LeaseToDate: null }, [])).toBe(false);
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
// resolveLeaseBalancesPerMonth — REBUILT 2026-07-07, replaces
// resolvePaymentDatesPerMonth in the live pipeline (see LATE_BALANCE_THRESHOLD
// and resolveLeaseBalancesPerMonth's own comment in rentCollection.ts for
// why: "paid by 3rd/10th" needs the balance STILL OWED as of a cutoff, not
// a binary fully-paid-or-not answer).
// ============================================================================
describe("resolveLeaseBalancesPerMonth", () => {
  it("reports zero balance at both cutoffs when paid in full on the 1st", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1500, glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-06-01", TransactionType: "Payment", TotalAmount: -1500, glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    const result = resolveLeaseBalancesPerMonth("10", transactions);
    expect(result).toEqual([{ leaseId: "10", month: "2026-06", balanceByThird: 0, balanceByTenth: 0, balanceByMonthEnd: 0 }]);
  });

  it("reports the full charge as owed at both cutoffs when nothing has been paid", () => {
    const transactions = [txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1500, glLines: [[RENT_INCOME, "Rent Income", 1500]] })];
    const result = resolveLeaseBalancesPerMonth("10", transactions);
    expect(result).toEqual([{ leaseId: "10", month: "2026-06", balanceByThird: 1500, balanceByTenth: 1500, balanceByMonthEnd: 1500 }]);
  });

  it("reports the remaining balance owed after a partial payment, not just paid/unpaid", () => {
    // Owes $1500, pays $1450 on the 2nd — $50 still owed at both cutoffs,
    // under the $200 threshold so this would count as "paid" upstream.
    const transactions = [
      txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1500, glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-06-02", TransactionType: "Payment", TotalAmount: -1450, glLines: [[RENT_INCOME, "Rent Income", -1450]] }),
    ];
    const result = resolveLeaseBalancesPerMonth("10", transactions);
    expect(result).toEqual([{ leaseId: "10", month: "2026-06", balanceByThird: 50, balanceByTenth: 50, balanceByMonthEnd: 50 }]);
  });

  it("date boundary: a credit dated exactly on the 3rd/10th counts toward that cutoff (inclusive)", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1000, glLines: [[RENT_INCOME, "Rent Income", 1000]] }),
      txn({ Id: 2, Date: "2026-06-03", TransactionType: "Payment", TotalAmount: -600, glLines: [[RENT_INCOME, "Rent Income", -600]] }),
      txn({ Id: 3, Date: "2026-06-10", TransactionType: "Payment", TotalAmount: -400, glLines: [[RENT_INCOME, "Rent Income", -400]] }),
    ];
    const result = resolveLeaseBalancesPerMonth("10", transactions);
    expect(result).toEqual([{ leaseId: "10", month: "2026-06", balanceByThird: 400, balanceByTenth: 0, balanceByMonthEnd: 0 }]);
  });

  it("balance owed shrinks as later credits (dated after the 3rd but by the 10th) come in", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1000, glLines: [[RENT_INCOME, "Rent Income", 1000]] }),
      txn({ Id: 2, Date: "2026-06-07", TransactionType: "Payment", TotalAmount: -1000, glLines: [[RENT_INCOME, "Rent Income", -1000]] }),
    ];
    const result = resolveLeaseBalancesPerMonth("10", transactions);
    expect(result).toEqual([{ leaseId: "10", month: "2026-06", balanceByThird: 1000, balanceByTenth: 0, balanceByMonthEnd: 0 }]);
  });

  // ADDED 2026-07-09, per Jason directly: the key insight behind why the
  // sync no longer excludes the still-in-progress current month at all
  // (see syncRoutes.ts). A cutoff that hasn't happened yet (e.g. asking for
  // "balance by the 10th" while today is only the 7th) can only ever see
  // whatever credits actually exist in Buildium's real data — and Buildium
  // never has transactions dated in the future. So balanceByTenth and
  // balanceByMonthEnd here AUTOMATICALLY equal "balance as of the last
  // known transaction" (i.e. as of today, once synced) with zero special-
  // casing needed — a genuinely live, correct, rolling number for free.
  it("a cutoff with no data beyond it yet naturally reads as a live 'balance as of today' figure — no special-casing needed", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", TotalAmount: 1790, glLines: [[RENT_INCOME, "Rent Income", 1790]] }),
      txn({ Id: 2, Date: "2026-07-07", TransactionType: "Payment", TotalAmount: -1690, glLines: [[RENT_INCOME, "Rent Income", -1690]] }),
      // No transactions dated after 7/7 exist yet — exactly what Buildium's
      // real data looks like for an in-progress month synced before it ends.
    ];
    const result = resolveLeaseBalancesPerMonth("10", transactions);
    // balanceByTenth and balanceByMonthEnd both "want" a cutoff (7/10, 7/31)
    // that hasn't happened yet — since no credits exist past 7/7 regardless,
    // they land on the exact same answer as "balance today" would.
    expect(result).toEqual([{ leaseId: "10", month: "2026-07", balanceByThird: 1790, balanceByTenth: 100, balanceByMonthEnd: 100 }]);
  });

  // Real case flagged live by Jason: lease 2066996, 4513 Indies Court.
  // Tenant's July rent ($1790, GL 3) was paid in full on 7/1, then that same
  // payment bounced (NSF) — Buildium records the bounce as a "Reversed
  // Payment" transaction whose Journal.Lines mirror the original payment
  // (+1790 on GL 3, dated 7/6, confirmed live via fetchLeaseTransactions).
  // Current real state as of this fix: no replacement payment has posted
  // yet, so July's rent should read as still fully owed at BOTH cutoffs —
  // the reversal correctly "un-pays" the 7/1 credit with no special-casing.
  it("an NSF-bounced payment (Reversed Payment mirrors the original credit) leaves the charge owed again", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", TotalAmount: 1790, glLines: [[RENT_INCOME, "Rent Income", 1790]] }),
      txn({ Id: 2, Date: "2026-07-01", TransactionType: "Payment", TotalAmount: -1885.95, glLines: [[RENT_INCOME, "Rent Income", -1790]] }),
      txn({ Id: 3, Date: "2026-07-06", TransactionType: "Reversed Payment", TotalAmount: 1885.95, glLines: [[RENT_INCOME, "Rent Income", 1790]] }),
    ];
    const result = resolveLeaseBalancesPerMonth("2066996", transactions);
    expect(result).toEqual([{ leaseId: "2066996", month: "2026-07", balanceByThird: 1790, balanceByTenth: 1790, balanceByMonthEnd: 1790 }]);
  });

  // Same real bounce, but with a hypothetical real replacement payment
  // landing on 7/8 — matching Jason's own description: "what may not have
  // shown up on the 3rd, may show up on the 6th." 7/8 is after the 3rd-day
  // cutoff but still on/before the 10th-day cutoff, so this lease should be
  // late for "by the 3rd" but caught up for "by the 10th" — proving the
  // reversal-then-repayment sequence resolves to exactly that outcome with
  // no special-casing.
  it("a replacement payment landing between the two cutoffs is late for the 3rd but caught up by the 10th", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", TotalAmount: 1790, glLines: [[RENT_INCOME, "Rent Income", 1790]] }),
      txn({ Id: 2, Date: "2026-07-01", TransactionType: "Payment", TotalAmount: -1885.95, glLines: [[RENT_INCOME, "Rent Income", -1790]] }),
      txn({ Id: 3, Date: "2026-07-06", TransactionType: "Reversed Payment", TotalAmount: 1885.95, glLines: [[RENT_INCOME, "Rent Income", 1790]] }),
      txn({ Id: 4, Date: "2026-07-08", TransactionType: "Payment", TotalAmount: -1790, glLines: [[RENT_INCOME, "Rent Income", -1790]] }),
    ];
    const result = resolveLeaseBalancesPerMonth("2066996", transactions);
    expect(result).toEqual([{ leaseId: "2066996", month: "2026-07", balanceByThird: 1790, balanceByTenth: 0, balanceByMonthEnd: 0 }]);
  });

  // Real case confirmed live by Jason 2026-07-07: lease 2819658, 3631 Chase
  // Court, is an inherited lease genuinely not late until after the 5th —
  // see LATE_CUTOFF_DAY_OVERRIDE_BY_LEASE_ID in rentCollection.ts.
  describe("per-lease grace-period override (LATE_CUTOFF_DAY_OVERRIDE_BY_LEASE_ID)", () => {
    it("uses the overridden cutoff day (5th) for a lease with a documented exception, instead of the standard 3rd", () => {
      const transactions = [
        txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1450, glLines: [[RENT_INCOME, "Rent Income", 1450]] }),
        txn({ Id: 2, Date: "2026-06-05", TransactionType: "Payment", TotalAmount: -1450, glLines: [[RENT_INCOME, "Rent Income", -1450]] }),
      ];
      const result = resolveLeaseBalancesPerMonth("2819658", transactions);
      // Paid on the 5th: a standard lease would still show this as owed as
      // of the 3rd, but 2819658's real cutoff is the 5th, so this should
      // already read as paid ($0) for balanceByThird.
      expect(result).toEqual([{ leaseId: "2819658", month: "2026-06", balanceByThird: 0, balanceByTenth: 0, balanceByMonthEnd: 0 }]);
    });

    it("still shows a balance owed if paid AFTER the overridden 5th-day cutoff", () => {
      const transactions = [
        txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1450, glLines: [[RENT_INCOME, "Rent Income", 1450]] }),
        txn({ Id: 2, Date: "2026-06-06", TransactionType: "Payment", TotalAmount: -1450, glLines: [[RENT_INCOME, "Rent Income", -1450]] }),
      ];
      const result = resolveLeaseBalancesPerMonth("2819658", transactions);
      expect(result[0].balanceByThird).toBe(1450); // paid on the 6th — even the overridden 5th-day cutoff has passed
      expect(result[0].balanceByTenth).toBe(0); // still well within the 10th, override or not
    });

    it("does not affect a lease with no override — standard leases keep the 3rd-day cutoff", () => {
      const transactions = [
        txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1450, glLines: [[RENT_INCOME, "Rent Income", 1450]] }),
        txn({ Id: 2, Date: "2026-06-05", TransactionType: "Payment", TotalAmount: -1450, glLines: [[RENT_INCOME, "Rent Income", -1450]] }),
      ];
      const result = resolveLeaseBalancesPerMonth("9999999", transactions); // not in the override list
      expect(result[0].balanceByThird).toBe(1450); // paid on the 5th, but this lease's real cutoff is still the 3rd
    });

    it("confirms 2819658 is the only lease currently in the override list", () => {
      expect(Object.keys(LATE_CUTOFF_DAY_OVERRIDE_BY_LEASE_ID)).toEqual(["2819658"]);
      expect(LATE_CUTOFF_DAY_OVERRIDE_BY_LEASE_ID["2819658"]).toBe(5);
    });
  });
});

describe("lastDayOfMonth", () => {
  it("handles a 31-day month", () => {
    expect(lastDayOfMonth("2026-07")).toBe("2026-07-31");
  });

  it("handles a 30-day month", () => {
    expect(lastDayOfMonth("2026-06")).toBe("2026-06-30");
  });

  it("handles February in a leap year", () => {
    expect(lastDayOfMonth("2024-02")).toBe("2024-02-29");
  });

  it("handles February in a non-leap year", () => {
    expect(lastDayOfMonth("2026-02")).toBe("2026-02-28");
  });

  it("handles December correctly (year-boundary edge case)", () => {
    expect(lastDayOfMonth("2025-12")).toBe("2025-12-31");
  });
});

// ============================================================================
// summarizeYearlyCollectionRates / findSameMonthLastYear — ADDED 2026-07-09
// for the new "Rent Collected by Month End" side panels next to the
// existing 12-month chart.
// ============================================================================
function monthlyRate(overrides: Partial<MonthlyCollectionRate>): MonthlyCollectionRate {
  return {
    month: "2026-01",
    totalLeasesDue: 0,
    paidByThirdCount: 0,
    paidByThirdPercent: 0,
    paidByTenthCount: 0,
    paidByTenthPercent: 0,
    paidByMonthEndCount: 0,
    paidByMonthEndPercent: 0,
    ...overrides,
  };
}

describe("summarizeYearlyCollectionRates", () => {
  it("rolls monthly by-month-end figures up to one ratio-of-sums percentage per year", () => {
    const months = [
      monthlyRate({ month: "2025-11", totalLeasesDue: 150, paidByMonthEndCount: 148 }),
      monthlyRate({ month: "2025-12", totalLeasesDue: 160, paidByMonthEndCount: 159 }),
      monthlyRate({ month: "2026-01", totalLeasesDue: 165, paidByMonthEndCount: 160 }),
    ];
    const result = summarizeYearlyCollectionRates(months);
    expect(result).toEqual([
      { year: "2026", totalLeasesDue: 165, paidByMonthEndCount: 160, paidByMonthEndPercent: 97, monthsIncluded: 1, lastMonth: "2026-01" },
      { year: "2025", totalLeasesDue: 310, paidByMonthEndCount: 307, paidByMonthEndPercent: 99, monthsIncluded: 2, lastMonth: "2025-12" },
    ]);
  });

  it("uses a ratio of SUMS, not an average of monthly percentages — a big month should outweigh a small one", () => {
    // Month A: 10 leases, all 10 paid (100%). Month B: 200 leases, only 100 paid (50%).
    // A naive average of percentages would say (100+50)/2 = 75%. The correct
    // portfolio-wide answer, weighting by how many leases each month actually
    // had, is (10+100)/(10+200) = 52.4%.
    const months = [
      monthlyRate({ month: "2026-01", totalLeasesDue: 10, paidByMonthEndCount: 10 }),
      monthlyRate({ month: "2026-02", totalLeasesDue: 200, paidByMonthEndCount: 100 }),
    ];
    const result = summarizeYearlyCollectionRates(months);
    expect(result[0].paidByMonthEndPercent).toBe(52.4);
  });

  it("sorts most recent year first", () => {
    const months = [
      monthlyRate({ month: "2023-06" }),
      monthlyRate({ month: "2025-06" }),
      monthlyRate({ month: "2024-06" }),
    ];
    const result = summarizeYearlyCollectionRates(months);
    expect(result.map((r) => r.year)).toEqual(["2025", "2024", "2023"]);
  });

  it("returns an empty array for no months at all", () => {
    expect(summarizeYearlyCollectionRates([])).toEqual([]);
  });

  it("reports monthsIncluded so a partial current year can be told apart from a complete one", () => {
    const months = [monthlyRate({ month: "2026-01" }), monthlyRate({ month: "2026-02" })];
    const result = summarizeYearlyCollectionRates(months);
    expect(result[0].monthsIncluded).toBe(2); // year-to-date, not a full 12
  });

  // ADDED 2026-07-09, per Jason directly: the side panel shows the month
  // next to the year (e.g. "Jun 2026" rather than a bare "2026"), so this
  // needs the actual LATEST month, not just a count.
  it("reports lastMonth as the most recent month actually included, even if the input isn't sorted", () => {
    const months = [
      monthlyRate({ month: "2026-03" }),
      monthlyRate({ month: "2026-01" }), // out of order on purpose
      monthlyRate({ month: "2026-02" }),
    ];
    const result = summarizeYearlyCollectionRates(months);
    expect(result[0].lastMonth).toBe("2026-03");
  });

  it("a complete past year's lastMonth is December", () => {
    const months = [monthlyRate({ month: "2025-01" }), monthlyRate({ month: "2025-12" }), monthlyRate({ month: "2025-06" })];
    const result = summarizeYearlyCollectionRates(months);
    expect(result[0].lastMonth).toBe("2025-12");
  });
});

describe("findSameMonthLastYear", () => {
  it("finds the same calendar month one year earlier", () => {
    const months = [
      monthlyRate({ month: "2025-06", paidByMonthEndPercent: 99.8 }),
      monthlyRate({ month: "2026-06", paidByMonthEndPercent: 95.2 }),
    ];
    const result = findSameMonthLastYear(months, "2026-06");
    expect(result).toEqual({ month: "2026-06", lastYearMonth: "2025-06", lastYearPercent: 99.8 });
  });

  it("returns null when last year's same month isn't in the data at all", () => {
    const months = [monthlyRate({ month: "2026-06", paidByMonthEndPercent: 95.2 })];
    const result = findSameMonthLastYear(months, "2026-06");
    expect(result).toBeNull();
  });

  it("handles January correctly (year rolls back, not just the month number)", () => {
    const months = [monthlyRate({ month: "2025-01", paidByMonthEndPercent: 88 })];
    const result = findSameMonthLastYear(months, "2026-01");
    expect(result).toEqual({ month: "2026-01", lastYearMonth: "2025-01", lastYearPercent: 88 });
  });
});

// ============================================================================
// securityDepositMoveOutWindow / extractSecurityDepositWithheld /
// summarizeSecurityDepositWithheld — REBUILT 2026-07-10, per Jason
// directly, matching the vendor's own real documented methodology.
// Fixtures modeled on real leases confirmed live: 2540300 (2421 Arkansas
// Avenue) matches the vendor's own drill-down exactly at $2,450/$2,450/
// 100%; 796009 and 1501179 (2417/2421 Arkansas Avenue) confirmed the two
// real memo casings Buildium actually uses for the same real reconciliation
// entry ("Deposit applied to balances" and "Security Deposit applied to
// balances").
// ============================================================================
describe("securityDepositMoveOutWindow", () => {
  it("start is 13 months before asOf, end is 30 days before asOf", () => {
    const result = securityDepositMoveOutWindow(new Date("2026-07-09T00:00:00Z"));
    expect(result).toEqual({ start: "2025-06-09", end: "2026-06-09" });
  });
});

describe("extractSecurityDepositWithheld", () => {
  // Real case: lease 2540300, 2421 Arkansas Avenue — vendor's own
  // drill-down shows this exact move-out at $2,450/$2,450/100%.
  it("sums an Applied Deposit transaction whose memo matches the real reconciliation entry", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      txn({ Id: 1, Date: "2026-03-11", TransactionType: "Applied Deposit", TotalAmount: -2450, memo: "Deposit applied to balances" }),
    ];
    const result = extractSecurityDepositWithheld("2540300", transactions);
    expect(result).toEqual({ leaseId: "2540300", withheld: 2450, hasQualifyingEntry: true });
  });

  // Real case: lease 1501179, 2421 Arkansas Avenue — same real reconciliation
  // concept, but Buildium recorded it with the OTHER real memo casing
  // ("Security Deposit applied to balances," not "Deposit applied to
  // balances"). Both must qualify — a case-insensitive SUBSTRING match,
  // not an exact string match.
  it("also matches the 'Security Deposit applied to balances' memo variant", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      txn({ Id: 1, Date: "2024-05-09", TransactionType: "Applied Deposit", TotalAmount: -860, memo: "Security Deposit applied to balances" }),
    ];
    const result = extractSecurityDepositWithheld("1501179", transactions);
    expect(result).toEqual({ leaseId: "1501179", withheld: 860, hasQualifyingEntry: true });
  });

  it("is case-insensitive on the memo match", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      txn({ Id: 1, Date: "2026-03-11", TransactionType: "Applied Deposit", TotalAmount: -500, memo: "DEPOSIT APPLIED TO BALANCES" }),
    ];
    const result = extractSecurityDepositWithheld("1", transactions);
    expect(result.hasQualifyingEntry).toBe(true);
  });

  // The vendor's own note explicitly calls this out: "Applied Deposit" is
  // ALSO used for monthly prepayment applications, which have nothing to
  // do with a security deposit and must not be counted.
  it("excludes an Applied Deposit transaction whose memo does NOT match the real reconciliation entry", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      txn({ Id: 1, Date: "2026-04-01", TransactionType: "Applied Deposit", TotalAmount: -1450, memo: "Applied Prepayment" }),
    ];
    const result = extractSecurityDepositWithheld("1", transactions);
    expect(result).toEqual({ leaseId: "1", withheld: 0, hasQualifyingEntry: false });
  });

  it("excludes an Applied Deposit transaction with no memo at all", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      txn({ Id: 1, Date: "2026-04-01", TransactionType: "Applied Deposit", TotalAmount: -1450 }), // no memo override — Journal.Memo is null
    ];
    const result = extractSecurityDepositWithheld("1", transactions);
    expect(result.hasQualifyingEntry).toBe(false);
  });

  it("sums multiple qualifying entries on the same lease", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      txn({ Id: 1, Date: "2026-03-11", TransactionType: "Applied Deposit", TotalAmount: -1000, memo: "Deposit applied to balances" }),
      txn({ Id: 2, Date: "2026-03-15", TransactionType: "Applied Deposit", TotalAmount: -450, memo: "Deposit applied to balances" }),
    ];
    const result = extractSecurityDepositWithheld("1", transactions);
    expect(result.withheld).toBe(1450);
  });

  it("ignores Refund transactions entirely — not part of this calculation at all, per the vendor's own rule", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      txn({ Id: 1, Date: "2025-08-01", TransactionType: "Refund", TotalAmount: 2200 }),
    ];
    const result = extractSecurityDepositWithheld("1", transactions);
    expect(result).toEqual({ leaseId: "1", withheld: 0, hasQualifyingEntry: false });
  });

  it("reports hasQualifyingEntry:false when no Applied Deposit transaction exists at all yet", () => {
    const transactions: BuildiumLeaseTransaction[] = [
      txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", TotalAmount: 1500 }),
      txn({ Id: 2, Date: "2026-06-01", TransactionType: "Payment", TotalAmount: -1500 }),
    ];
    const result = extractSecurityDepositWithheld("1", transactions);
    expect(result.hasQualifyingEntry).toBe(false);
  });
});

describe("summarizeSecurityDepositWithheld", () => {
  it("computes the dollar figure as a plain average, and the percent as a ratio of sums", () => {
    // Two leases with very different deposit sizes — a naive average of
    // percentages would treat them equally; ratio-of-sums correctly
    // weights the larger deposit more for the PERCENT figure. The DOLLAR
    // figure is still a plain average of the (capped) withheld amounts —
    // confirmed against the vendor's real 34-row list (avg withheld =
    // $1,203.3 ≈ their displayed $1,203).
    const rows = [
      { withheld: 1000, securityDeposit: 1000 }, // 100%
      { withheld: 400, securityDeposit: 4000 }, // 10%
    ];
    const result = summarizeSecurityDepositWithheld(rows);
    expect(result.avgSecurityDepositWithheld).toBe(700); // (1000+400)/2
    expect(result.avgSecurityDepositWithheldPercent).toBe(28); // sum(withheld)=1400, sum(deposit)=5000 -> 28%, NOT (100%+10%)/2=55%
    expect(result.reconciledLeaseCount).toBe(2);
  });

  it("returns nulls and a zero count for an empty row list (nothing reconciled yet)", () => {
    const result = summarizeSecurityDepositWithheld([]);
    expect(result).toEqual({ avgSecurityDepositWithheld: null, avgSecurityDepositWithheldPercent: null, reconciledLeaseCount: 0 });
  });

  // Full real 34-move-out check, matching the vendor's own live drill-down
  // list exactly (captured 2026-07-09) — this is the same real-money math
  // the vendor site's Avg SD Withheld / Avg SD Withheld % tiles show.
  it("matches the vendor's real 34-move-out portfolio calculation ($1,203 / 57%)", () => {
    const rows = [
      { withheld: 2450, securityDeposit: 2450 },
      { withheld: 2200, securityDeposit: 2200 },
      { withheld: 2200, securityDeposit: 2200 },
      { withheld: 2350, securityDeposit: 2350 },
      { withheld: 950, securityDeposit: 950 },
      { withheld: 1837.5, securityDeposit: 1837.5 },
      { withheld: 2100, securityDeposit: 2100 },
      { withheld: 1385, securityDeposit: 1385 },
      { withheld: 3250, securityDeposit: 3250 },
      { withheld: 2400, securityDeposit: 2400 },
      { withheld: 1385, securityDeposit: 1695 },
      { withheld: 2186.55, securityDeposit: 2700 },
      { withheld: 1315.72, securityDeposit: 1650 },
      { withheld: 1558.35, securityDeposit: 2495 },
      { withheld: 1354, securityDeposit: 2395 },
      { withheld: 1075, securityDeposit: 2025 },
      { withheld: 875, securityDeposit: 1700 },
      { withheld: 1432.2, securityDeposit: 3000 },
      { withheld: 800, securityDeposit: 1700 },
      { withheld: 1060, securityDeposit: 2300 },
      { withheld: 883.6, securityDeposit: 1975 },
      { withheld: 1650, securityDeposit: 3700 },
      { withheld: 746, securityDeposit: 1735 },
      { withheld: 678, securityDeposit: 1595 },
      { withheld: 964, securityDeposit: 2995 },
      { withheld: 271.2, securityDeposit: 1025 },
      { withheld: 288.96, securityDeposit: 1160 },
      { withheld: 241.32, securityDeposit: 1445 },
      { withheld: 176.2, securityDeposit: 1100 },
      { withheld: 275.52, securityDeposit: 1850 },
      { withheld: 150, securityDeposit: 1695 },
      { withheld: 200.58, securityDeposit: 2325 },
      { withheld: 187.5, securityDeposit: 2925 },
      { withheld: 35, securityDeposit: 2860 },
    ];
    expect(rows).toHaveLength(34);
    const result = summarizeSecurityDepositWithheld(rows);
    expect(result.avgSecurityDepositWithheld).toBe(1203.3);
    expect(result.avgSecurityDepositWithheldPercent).toBe(57.5);
    expect(result.reconciledLeaseCount).toBe(34);
  });
});
