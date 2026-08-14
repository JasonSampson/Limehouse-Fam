import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BuildiumGlAccount, LeaseBalance } from "../../src/buildium/client.js";

// Root-cause regression coverage for the 2026-07-02 itemization bug: a real
// notice preview computed an itemized "Rent" total of $110,044.67 against a
// real live balance of $3,115.95 for lease 2317038, because the old code
// summed EVERY charge ever posted to the lease (/leases/{id}/charges, full
// lifetime ledger) instead of the CURRENT outstanding balance. The fix
// classifies Buildium's `Balances` per-GL-account breakdown from
// /leases/outstandingbalances instead — this file locks in that the bucket
// sums always reconcile exactly to the true live balance, including the
// tricky negative/credit-on-one-GL-account case found live on real leases
// 2490757 and 2687271.
//
// fetchLeaseOutstandingBalance / fetchGlAccountsById are mocked here — this
// is a pure-unit test (see vitest.config.ts), no live Buildium call, no DB.
vi.mock("../../src/buildium/client.js", () => ({
  fetchLeaseOutstandingBalance: vi.fn(),
  fetchGlAccountsById: vi.fn(),
}));

const RENT_INCOME: BuildiumGlAccount = {
  Id: 3,
  Name: "Rent Income",
  Type: "Income",
  SubType: "Income",
  DefaultAccountName: "Rent Income",
  IsDefaultGLAccount: true,
};
const LATE_FEE_INCOME: BuildiumGlAccount = {
  Id: 8,
  Name: "Late Fee Income- Limehouse",
  Type: "Income",
  SubType: "Income",
  DefaultAccountName: "Late Fee Income",
  IsDefaultGLAccount: true,
};
const RBP: BuildiumGlAccount = {
  Id: 958019,
  Name: "Resident Benefits Package",
  Type: "Income",
  SubType: "Income",
  DefaultAccountName: null,
  IsDefaultGLAccount: false,
};
const ADMIN_FEE: BuildiumGlAccount = {
  Id: 812829,
  Name: "Admin Manual Payment Process Fee",
  Type: "Income",
  SubType: "Income",
  DefaultAccountName: null,
  IsDefaultGLAccount: false,
};
const SECURITY_DEPOSIT_LIABILITY: BuildiumGlAccount = {
  Id: 5,
  Name: "Security Deposit Liability",
  Type: "Liability",
  SubType: "CurrentLiability",
  DefaultAccountName: "Security Deposit Liability",
  IsDefaultGLAccount: true,
};
const COURT_COSTS: BuildiumGlAccount = {
  Id: 976019,
  Name: "Court Costs- Tenant",
  Type: "Income",
  SubType: "Income",
  DefaultAccountName: null,
  IsDefaultGLAccount: false,
};

function glMap(...accounts: BuildiumGlAccount[]): Map<number, BuildiumGlAccount> {
  return new Map(accounts.map((a) => [a.Id, a]));
}

function balance(overrides: Partial<LeaseBalance> & { balancesByGl: LeaseBalance["balancesByGl"] }): LeaseBalance {
  return {
    leaseId: "123",
    balance: 0,
    evictionPendingDate: null,
    ...overrides,
  };
}

describe("fetchAndClassifyLeaseCharges", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("reconciles exactly to the true live balance — the real lease 2317038 regression case", async () => {
    // Real numbers from lease 2317038: Rent Income $3070 + RBP $45.95 = the
    // real $3,115.95 balance. The OLD (buggy) code would have summed all 76
    // historical charges since 2023 instead ($116,080.61) — this test locks
    // in that only the CURRENT balance is used.
    const { fetchLeaseOutstandingBalance, fetchGlAccountsById } = await import("../../src/buildium/client.js");
    vi.mocked(fetchLeaseOutstandingBalance).mockResolvedValue(
      balance({
        leaseId: "2317038",
        balance: 3115.95,
        balancesByGl: [
          { glAccountId: 3, balance: 3070 },
          { glAccountId: 958019, balance: 45.95 },
          { glAccountId: 5, balance: 0 },
        ],
      })
    );
    vi.mocked(fetchGlAccountsById).mockResolvedValue(glMap(RENT_INCOME, RBP, SECURITY_DEPOSIT_LIABILITY));

    const { fetchAndClassifyLeaseCharges } = await import("../../src/lib/noticeLineItems.js");
    const result = await fetchAndClassifyLeaseCharges("2317038");

    expect(result.bucketTotals.rent).toBeCloseTo(3115.95, 2);
    expect(result.bucketTotals.late_fee).toBe(0);
    expect(result.bucketTotals.other).toBe(0);
    const total = result.bucketTotals.rent + result.bucketTotals.late_fee + result.bucketTotals.other;
    expect(total).toBeCloseTo(3115.95, 2);
  });

  it("nets a negative (credit) balance on one GL account into its bucket, still reconciling to the true total — real leases 2490757/2687271 case", async () => {
    // Real case found live: GL 812829 (Admin fee, late_fee bucket) sat at
    // -$25 while the lease still owed $1760 overall (Rent $1664.05 + RBP
    // $70.95 + Misc $50). Dropping the credit instead of netting it would
    // make bucketTotals sum to $1785 — $25 too high vs the true $1760.
    const { fetchLeaseOutstandingBalance, fetchGlAccountsById } = await import("../../src/buildium/client.js");
    vi.mocked(fetchLeaseOutstandingBalance).mockResolvedValue(
      balance({
        leaseId: "2490757",
        balance: 1760,
        balancesByGl: [
          { glAccountId: 812829, balance: -25 },
          { glAccountId: 3, balance: 1664.05 },
          { glAccountId: 958019, balance: 70.95 },
          { glAccountId: 1001770, balance: 50 },
        ],
      })
    );
    const OTHER_FEE: BuildiumGlAccount = {
      Id: 1001770,
      Name: "Some Other Fee",
      Type: "Income",
      SubType: "Income",
      DefaultAccountName: null,
      IsDefaultGLAccount: false,
    };
    vi.mocked(fetchGlAccountsById).mockResolvedValue(glMap(RENT_INCOME, RBP, ADMIN_FEE, OTHER_FEE));

    const { fetchAndClassifyLeaseCharges } = await import("../../src/lib/noticeLineItems.js");
    const result = await fetchAndClassifyLeaseCharges("2490757");

    const total = result.bucketTotals.rent + result.bucketTotals.late_fee + result.bucketTotals.other;
    expect(total).toBeCloseTo(1760, 2);
    expect(result.bucketTotals.late_fee).toBeCloseTo(-25, 2);

    // The credit line must NOT appear as its own notice_line_items row (DB
    // constraint requires amount > 0, and a legal notice must never display
    // a negative "amount owed" line).
    expect(result.positiveLines.every((l) => l.amount > 0)).toBe(true);
    expect(result.positiveLines.find((l) => l.buildiumGlAccountId === "812829")).toBeUndefined();
  });

  it("excludes non-charge accounts (Security Deposit Liability, Prepayments) from both lines and totals", async () => {
    const { fetchLeaseOutstandingBalance, fetchGlAccountsById } = await import("../../src/buildium/client.js");
    vi.mocked(fetchLeaseOutstandingBalance).mockResolvedValue(
      balance({
        balance: 1000,
        balancesByGl: [
          { glAccountId: 3, balance: 1000 },
          { glAccountId: 5, balance: 500 }, // Security Deposit Liability — never a tenant charge
        ],
      })
    );
    vi.mocked(fetchGlAccountsById).mockResolvedValue(glMap(RENT_INCOME, SECURITY_DEPOSIT_LIABILITY));

    const { fetchAndClassifyLeaseCharges } = await import("../../src/lib/noticeLineItems.js");
    const result = await fetchAndClassifyLeaseCharges("999");

    expect(result.bucketTotals.rent).toBe(1000);
    expect(result.bucketTotals.late_fee + result.bucketTotals.other).toBe(0);
    expect(result.positiveLines).toHaveLength(1);
  });

  it("throws UnclassifiedChargeBlockedError instead of silently guessing on an out-of-scope account (Court Costs)", async () => {
    const { fetchLeaseOutstandingBalance, fetchGlAccountsById } = await import("../../src/buildium/client.js");
    vi.mocked(fetchLeaseOutstandingBalance).mockResolvedValue(
      balance({
        balance: 1758,
        balancesByGl: [
          { glAccountId: 3, balance: 1000 },
          { glAccountId: 976019, balance: 758 }, // Court Costs — legally out of scope, must throw
        ],
      })
    );
    vi.mocked(fetchGlAccountsById).mockResolvedValue(glMap(RENT_INCOME, COURT_COSTS));

    const { fetchAndClassifyLeaseCharges, UnclassifiedChargeBlockedError } = await import(
      "../../src/lib/noticeLineItems.js"
    );
    await expect(fetchAndClassifyLeaseCharges("999")).rejects.toBeInstanceOf(UnclassifiedChargeBlockedError);
  });

  it("throws UnclassifiedChargeBlockedError when a GL account in the balance breakdown can't be resolved at all", async () => {
    const { fetchLeaseOutstandingBalance, fetchGlAccountsById } = await import("../../src/buildium/client.js");
    vi.mocked(fetchLeaseOutstandingBalance).mockResolvedValue(
      balance({
        balance: 500,
        balancesByGl: [{ glAccountId: 999999, balance: 500 }],
      })
    );
    vi.mocked(fetchGlAccountsById).mockResolvedValue(glMap()); // empty chart of accounts

    const { fetchAndClassifyLeaseCharges, UnclassifiedChargeBlockedError } = await import(
      "../../src/lib/noticeLineItems.js"
    );
    await expect(fetchAndClassifyLeaseCharges("999")).rejects.toBeInstanceOf(UnclassifiedChargeBlockedError);
  });

  it("skips zero-balance GL accounts entirely (not classified, not summed)", async () => {
    const { fetchLeaseOutstandingBalance, fetchGlAccountsById } = await import("../../src/buildium/client.js");
    vi.mocked(fetchLeaseOutstandingBalance).mockResolvedValue(
      balance({
        balance: 1000,
        balancesByGl: [
          { glAccountId: 3, balance: 1000 },
          { glAccountId: 8, balance: 0 },
        ],
      })
    );
    vi.mocked(fetchGlAccountsById).mockResolvedValue(glMap(RENT_INCOME, LATE_FEE_INCOME));

    const { fetchAndClassifyLeaseCharges } = await import("../../src/lib/noticeLineItems.js");
    const result = await fetchAndClassifyLeaseCharges("999");

    expect(result.bucketTotals.late_fee).toBe(0);
    expect(result.positiveLines).toHaveLength(1);
  });

  it("a lease with zero balance overall (all GL accounts at 0) produces zero totals and no lines", async () => {
    const { fetchLeaseOutstandingBalance, fetchGlAccountsById } = await import("../../src/buildium/client.js");
    vi.mocked(fetchLeaseOutstandingBalance).mockResolvedValue(
      balance({
        balance: 0,
        balancesByGl: [
          { glAccountId: 3, balance: 0 },
          { glAccountId: 5, balance: 0 },
        ],
      })
    );
    vi.mocked(fetchGlAccountsById).mockResolvedValue(glMap(RENT_INCOME, SECURITY_DEPOSIT_LIABILITY));

    const { fetchAndClassifyLeaseCharges } = await import("../../src/lib/noticeLineItems.js");
    const result = await fetchAndClassifyLeaseCharges("999");

    expect(result.bucketTotals).toEqual({ rent: 0, late_fee: 0, other: 0 });
    expect(result.positiveLines).toHaveLength(0);
  });
});

// 2026-08-14 fix: what counts as "behind on rent" for the lateness trigger
// (dailyLatenessCheck.ts, staleDraftCheck.ts, escalationCheck.ts) is rent +
// late fees, never a leftover 'other'-bucket fee on its own. Root-cause
// regression coverage for Jason's report: 1318 River Birch Run South and
// 1313 Tait Close both got a 14-day pay-or-quit notice over an unpaid $300
// Lease Change Fee alone, with zero rent actually owed.
describe("rentEquivalentBalance", () => {
  it("is rent plus late_fee, excluding other", async () => {
    const { rentEquivalentBalance } = await import("../../src/lib/noticeLineItems.js");
    expect(rentEquivalentBalance({ rent: 1200, late_fee: 50, other: 300 })).toBe(1250);
  });

  it("is zero when the only balance is a non-rent fee — the exact River Birch/Tait bug", async () => {
    const { rentEquivalentBalance } = await import("../../src/lib/noticeLineItems.js");
    expect(rentEquivalentBalance({ rent: 0, late_fee: 0, other: 300 })).toBe(0);
  });
});

describe("classifyBalanceLines — callable without a second Buildium fetch", () => {
  it("classifies pre-fetched balancesByGl the same way fetchAndClassifyLeaseCharges does", async () => {
    const { classifyBalanceLines } = await import("../../src/lib/noticeLineItems.js");
    const result = classifyBalanceLines(
      "999",
      [
        { glAccountId: 3, balance: 1000 },
        { glAccountId: 958019, balance: 50 },
      ],
      glMap(RENT_INCOME, RBP)
    );
    expect(result.bucketTotals).toEqual({ rent: 1050, late_fee: 0, other: 0 });
  });

  it("puts a Lease Change Fee in 'other', excluded from rentEquivalentBalance", async () => {
    const { classifyBalanceLines, rentEquivalentBalance } = await import("../../src/lib/noticeLineItems.js");
    const LEASE_CHANGE_FEE: BuildiumGlAccount = {
      Id: 857392,
      Name: "Lease Change Fee",
      Type: "Income",
      SubType: "Income",
      DefaultAccountName: null,
      IsDefaultGLAccount: false,
    };
    const result = classifyBalanceLines("999", [{ glAccountId: 857392, balance: 300 }], glMap(LEASE_CHANGE_FEE));

    expect(result.bucketTotals).toEqual({ rent: 0, late_fee: 0, other: 300 });
    expect(rentEquivalentBalance(result.bucketTotals)).toBe(0);
  });

  it("classifies Solar Rent into the rent bucket — confirmed live on 1149 Birks Lane, per Jason's explicit rule", async () => {
    const { classifyBalanceLines, rentEquivalentBalance } = await import("../../src/lib/noticeLineItems.js");
    const SOLAR_RENT: BuildiumGlAccount = {
      Id: 987307,
      Name: "Solar Rent",
      Type: "Income",
      SubType: "Income",
      DefaultAccountName: null,
      IsDefaultGLAccount: false,
    };
    const result = classifyBalanceLines("999", [{ glAccountId: 987307, balance: 85 }], glMap(SOLAR_RENT));

    expect(result.bucketTotals).toEqual({ rent: 85, late_fee: 0, other: 0 });
    expect(rentEquivalentBalance(result.bucketTotals)).toBe(85);
  });

  it("a mix of real rent and a non-rent fee only counts the rent portion toward the trigger, but keeps both on the itemization", async () => {
    const { classifyBalanceLines, rentEquivalentBalance } = await import("../../src/lib/noticeLineItems.js");
    const LEASE_CHANGE_FEE: BuildiumGlAccount = {
      Id: 857392,
      Name: "Lease Change Fee",
      Type: "Income",
      SubType: "Income",
      DefaultAccountName: null,
      IsDefaultGLAccount: false,
    };
    const result = classifyBalanceLines(
      "999",
      [
        { glAccountId: 3, balance: 1500 },
        { glAccountId: 857392, balance: 300 },
      ],
      glMap(RENT_INCOME, LEASE_CHANGE_FEE)
    );

    expect(rentEquivalentBalance(result.bucketTotals)).toBe(1500);
    // Still itemized in full once a real rent delinquency legitimately
    // triggers a notice — the fee doesn't disappear, it just can't trigger
    // on its own.
    expect(result.positiveLines).toHaveLength(2);
    const total = result.bucketTotals.rent + result.bucketTotals.late_fee + result.bucketTotals.other;
    expect(total).toBe(1800);
  });
});
