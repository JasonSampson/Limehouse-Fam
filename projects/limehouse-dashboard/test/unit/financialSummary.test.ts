import { describe, it, expect } from "vitest";
import {
  classifyGlAccountIds,
  summarizeFinancials,
  revenuePerUnit,
  checkGlHistoryCoverage,
} from "../../src/kpi/financialSummary.js";
import type { BuildiumGeneralLedgerAccount, BuildiumGlAccount } from "../../src/buildium/client.js";

const RENT_INCOME: BuildiumGlAccount = {
  Id: 3,
  Name: "Rent Income",
  Type: "Income",
  SubType: "Income",
  DefaultAccountName: "Rent Income",
  IsDefaultGLAccount: true,
};
const MGMT_FEE_INCOME: BuildiumGlAccount = {
  Id: 657394,
  Name: "Mgmnt Fee Income - LH Plan",
  Type: "Income",
  SubType: "Income",
  DefaultAccountName: null,
  IsDefaultGLAccount: false,
};
const REPAIRS_EXPENSE: BuildiumGlAccount = {
  Id: 636979,
  Name: "Repairs",
  Type: "Expense",
  SubType: "Expense",
  DefaultAccountName: null,
  IsDefaultGLAccount: false,
};
const SECURITY_DEPOSIT_LIABILITY: BuildiumGlAccount = {
  Id: 999,
  Name: "Security Deposit Liability",
  Type: "Liability",
  SubType: "CurrentLiability",
  DefaultAccountName: null,
  IsDefaultGLAccount: true,
};

const glAccountsById = new Map<number, BuildiumGlAccount>([
  [3, RENT_INCOME],
  [657394, MGMT_FEE_INCOME],
  [636979, REPAIRS_EXPENSE],
  [999, SECURITY_DEPOSIT_LIABILITY],
]);

function glAccount(overrides: Partial<BuildiumGeneralLedgerAccount>): BuildiumGeneralLedgerAccount {
  return {
    GLAccountId: 0,
    GLAccountName: "",
    BeginningBalance: 0,
    TotalAmount: 0,
    Entries: [],
    ...overrides,
  };
}

describe("classifyGlAccountIds", () => {
  it("splits the chart of accounts into Income and Expense account ID lists, excluding other types", () => {
    const result = classifyGlAccountIds(glAccountsById);
    expect(result.incomeAccountIds.sort()).toEqual([3, 657394]);
    expect(result.expenseAccountIds).toEqual([636979]);
  });
});

describe("summarizeFinancials", () => {
  it("computes gross income, expenses, and net income from GL account totals", () => {
    const incomeRows = [glAccount({ GLAccountId: 3, TotalAmount: 68000 }), glAccount({ GLAccountId: 657394, TotalAmount: 449.73 })];
    const expenseRows = [glAccount({ GLAccountId: 636979, TotalAmount: 300 })];
    const result = summarizeFinancials(incomeRows, expenseRows);
    expect(result).toEqual({ grossIncome: 68449.73, totalExpenses: 300, netIncome: 68149.73 });
  });

  it("matches the real live-verified Jan 2026 figure: Gross Income = $68,449.73 (Company entity 15695, Cash basis)", () => {
    const incomeRows = [glAccount({ GLAccountId: 657394, TotalAmount: 36599.75 }), glAccount({ GLAccountId: 8, TotalAmount: 31849.98 })];
    const result = summarizeFinancials(incomeRows, []);
    expect(result.grossIncome).toBe(68449.73);
  });

  it("returns zero for empty income/expense rows", () => {
    expect(summarizeFinancials([], [])).toEqual({ grossIncome: 0, totalExpenses: 0, netIncome: 0 });
  });

  it("rounds to the nearest cent", () => {
    const incomeRows = [glAccount({ TotalAmount: 100.005 }), glAccount({ TotalAmount: 0.001 })];
    const result = summarizeFinancials(incomeRows, []);
    expect(result.grossIncome).toBe(100.01);
  });
});

describe("revenuePerUnit", () => {
  it("divides gross income by unit count", () => {
    expect(revenuePerUnit({ month: "2026-06", grossIncome: 108007.18, unitCount: 233 })).toBe(463.55);
  });

  it("returns null instead of dividing by zero when unit count is 0", () => {
    expect(revenuePerUnit({ month: "2026-06", grossIncome: 23000, unitCount: 0 })).toBeNull();
  });
});

describe("checkGlHistoryCoverage", () => {
  it("reports fully covered when the earliest entry is at or before the requested start", () => {
    const incomeRows = [
      glAccount({ Entries: [{ Id: 1, Date: "2017-12-20", Description: null, Amount: 100, Balance: 100, TransactionType: "Payment" }] }),
      glAccount({ Entries: [{ Id: 2, Date: "2020-03-01", Description: null, Amount: 50, Balance: 150, TransactionType: "Payment" }] }),
    ];
    const coverage = checkGlHistoryCoverage(incomeRows, "2018-01-01");
    expect(coverage.fullyCovered).toBe(true);
    expect(coverage.earliestEntryDate).toBe("2017-12-20");
  });

  it("reports NOT fully covered when real data starts later than requested (must not silently truncate)", () => {
    const incomeRows = [
      glAccount({ Entries: [{ Id: 1, Date: "2021-06-01", Description: null, Amount: 100, Balance: 100, TransactionType: "Payment" }] }),
    ];
    const coverage = checkGlHistoryCoverage(incomeRows, "2018-01-01");
    expect(coverage.fullyCovered).toBe(false);
    expect(coverage.earliestEntryDate).toBe("2021-06-01");
  });

  it("reports not covered with a null earliest date when there are no entries at all", () => {
    const coverage = checkGlHistoryCoverage([], "2018-01-01");
    expect(coverage.fullyCovered).toBe(false);
    expect(coverage.earliestEntryDate).toBeNull();
  });
});
