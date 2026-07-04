import { describe, it, expect } from "vitest";
import {
  summarizeMonthlyFinancials,
  revenuePerUnit,
  checkGlHistoryCoverage,
} from "../../src/kpi/financialSummary.js";
import type { BuildiumGlAccount, BuildiumGlEntry } from "../../src/buildium/client.js";

const RENT_INCOME: BuildiumGlAccount = {
  Id: 1,
  Name: "Rent Income",
  Type: "Income",
  SubType: "Income",
  DefaultAccountName: "Rent Income",
  IsDefaultGLAccount: true,
};
const REPAIRS_EXPENSE: BuildiumGlAccount = {
  Id: 2,
  Name: "Repairs & Maintenance",
  Type: "Expense",
  SubType: "Expense",
  DefaultAccountName: null,
  IsDefaultGLAccount: false,
};
const SECURITY_DEPOSIT_LIABILITY: BuildiumGlAccount = {
  Id: 3,
  Name: "Security Deposit Liability",
  Type: "Liability",
  SubType: "CurrentLiability",
  DefaultAccountName: null,
  IsDefaultGLAccount: true,
};

const glAccountsById = new Map<number, BuildiumGlAccount>([
  [1, RENT_INCOME],
  [2, REPAIRS_EXPENSE],
  [3, SECURITY_DEPOSIT_LIABILITY],
]);

describe("summarizeMonthlyFinancials", () => {
  it("computes gross income, expenses, and net income per month", () => {
    const entries: BuildiumGlEntry[] = [
      {
        Id: 1,
        Date: "2026-06-05",
        Memo: "Rent payment",
        Lines: [{ GlAccountId: 1, Amount: 1500, PostingType: "Credit" }],
      },
      {
        Id: 2,
        Date: "2026-06-12",
        Memo: "Plumbing repair",
        Lines: [{ GlAccountId: 2, Amount: 300, PostingType: "Debit" }],
      },
    ];
    const result = summarizeMonthlyFinancials(entries, glAccountsById);
    expect(result).toEqual([{ month: "2026-06", grossIncome: 1500, totalExpenses: 300, netIncome: 1200 }]);
  });

  it("buckets entries into separate months correctly", () => {
    const entries: BuildiumGlEntry[] = [
      { Id: 1, Date: "2026-05-30", Memo: null, Lines: [{ GlAccountId: 1, Amount: 1000, PostingType: "Credit" }] },
      { Id: 2, Date: "2026-06-01", Memo: null, Lines: [{ GlAccountId: 1, Amount: 1200, PostingType: "Credit" }] },
    ];
    const result = summarizeMonthlyFinancials(entries, glAccountsById);
    expect(result.map((r) => r.month)).toEqual(["2026-05", "2026-06"]);
  });

  it("ignores non-Income/Expense GL lines (e.g. security deposit liability) so they don't distort income", () => {
    const entries: BuildiumGlEntry[] = [
      {
        Id: 1,
        Date: "2026-06-05",
        Memo: "Deposit collected",
        Lines: [{ GlAccountId: 3, Amount: 1000, PostingType: "Credit" }],
      },
    ];
    const result = summarizeMonthlyFinancials(entries, glAccountsById);
    expect(result).toEqual([{ month: "2026-06", grossIncome: 0, totalExpenses: 0, netIncome: 0 }]);
  });

  it("skips lines with an unresolvable GLAccountId rather than misclassifying them", () => {
    const entries: BuildiumGlEntry[] = [
      {
        Id: 1,
        Date: "2026-06-05",
        Memo: null,
        Lines: [
          { GlAccountId: 1, Amount: 1000, PostingType: "Credit" },
          { GlAccountId: 99999, Amount: 500, PostingType: "Credit" }, // not in the map
        ],
      },
    ];
    const result = summarizeMonthlyFinancials(entries, glAccountsById);
    expect(result[0].grossIncome).toBe(1000);
  });

  it("returns an empty array for no entries", () => {
    expect(summarizeMonthlyFinancials([], glAccountsById)).toEqual([]);
  });
});

describe("revenuePerUnit", () => {
  it("divides gross income by unit count", () => {
    expect(revenuePerUnit({ month: "2026-06", grossIncome: 23000, unitCount: 230 })).toBe(100);
  });

  it("returns null instead of dividing by zero when unit count is 0", () => {
    expect(revenuePerUnit({ month: "2026-06", grossIncome: 23000, unitCount: 0 })).toBeNull();
  });
});

describe("checkGlHistoryCoverage", () => {
  it("reports fully covered when the earliest entry is at or before the requested start", () => {
    const entries: BuildiumGlEntry[] = [
      { Id: 1, Date: "2017-12-20", Memo: null, Lines: [] },
      { Id: 2, Date: "2020-03-01", Memo: null, Lines: [] },
    ];
    const coverage = checkGlHistoryCoverage(entries, "2018-01-01");
    expect(coverage.fullyCovered).toBe(true);
    expect(coverage.earliestEntryDate).toBe("2017-12-20");
  });

  it("reports NOT fully covered when real data starts later than requested (must not silently truncate)", () => {
    const entries: BuildiumGlEntry[] = [{ Id: 1, Date: "2021-06-01", Memo: null, Lines: [] }];
    const coverage = checkGlHistoryCoverage(entries, "2018-01-01");
    expect(coverage.fullyCovered).toBe(false);
    expect(coverage.earliestEntryDate).toBe("2021-06-01");
  });

  it("reports not covered with a null earliest date when there are no entries at all", () => {
    const coverage = checkGlHistoryCoverage([], "2018-01-01");
    expect(coverage.fullyCovered).toBe(false);
    expect(coverage.earliestEntryDate).toBeNull();
  });
});
