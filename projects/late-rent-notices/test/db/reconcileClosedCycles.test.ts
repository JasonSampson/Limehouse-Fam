import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getTestSuperuserPool, truncateAllTables, closeAllTestPools } from "../support/testDb.js";
import { reconcileClosedCycles } from "../../src/jobs/dailyLatenessCheck.js";
import { startTrace } from "../../src/lib/trace.js";
import type { BuildiumGlAccount, LeaseBalance } from "../../src/buildium/client.js";
import {
  seedPmUser,
  seedProperty,
  seedPmPropertyAssignment,
  seedLease,
  seedActiveConfigValue,
  seedLetterTemplate,
  seedLateCycle,
  seedNotice,
} from "../support/seed.js";

// A single fake "Rent Income" GL account, resolved the same way a real
// classifyGlAccount(...) call would resolve Buildium's own Rent Income
// account (IsDefaultGLAccount + DefaultAccountName — see glClassification.ts)
// — reconcileClosedCycles now classifies balancesByGl before deciding
// whether a cycle is still genuinely late (2026-08-14 fix), so every test
// balance below needs a real, resolvable GL account behind it.
const RENT_GL_ACCOUNT_ID = 1;
function fakeGlAccountsById(): Map<number, BuildiumGlAccount> {
  return new Map([
    [
      RENT_GL_ACCOUNT_ID,
      {
        Id: RENT_GL_ACCOUNT_ID,
        Name: "Rent Income",
        Type: "Income",
        SubType: "Income",
        DefaultAccountName: "Rent Income",
        IsDefaultGLAccount: true,
      },
    ],
  ]);
}
function fakeBalance(leaseId: string, balance: number): LeaseBalance {
  return {
    leaseId,
    balance,
    evictionPendingDate: null,
    balancesByGl: balance === 0 ? [] : [{ glAccountId: RENT_GL_ACCOUNT_ID, balance }],
  };
}

// Root cause of the bug Jason reported (1909 Chesapeake Dr showed up as
// needing a notice after rent was credited the same day): the daily job's
// main loop only ever visits leases Buildium's bulk balances endpoint
// still reports as owing something — a lease that pays off drops out of
// that list entirely and is never revisited, so its late_cycles row (and
// any still-draft notice) stayed open/pending forever. This exercises
// reconcileClosedCycles directly against real seeded rows, the same way
// gracePeriodConfig.test.ts exercises SQL logic without mocking Buildium —
// callers just need a plain outstandingBalances array, no live API call.
const DE_MINIMIS_THRESHOLD = 100;

describe("reconcileClosedCycles — closes stale late_cycles/notices once a tenant pays", () => {
  const pool = getTestSuperuserPool();
  let pmId: number;
  let propertyId: number;
  let deMinimisConfigId: number;
  let letterTemplateId: number;

  beforeEach(async () => {
    await truncateAllTables();
    pmId = await seedPmUser(pool, { email: "reconcile-test@limehousepm.com" });
    propertyId = await seedProperty(pool, { buildiumPropertyId: "PROP-RECONCILE" });
    await seedPmPropertyAssignment(pool, pmId, propertyId);
    deMinimisConfigId = await seedActiveConfigValue(pool, {
      configKey: "de_minimis_threshold",
      value: DE_MINIMIS_THRESHOLD,
      setByPmId: pmId,
    });
    letterTemplateId = await seedLetterTemplate(pool, { createdByPmId: pmId });
  });

  afterAll(async () => {
    await closeAllTestPools();
  });

  it("closes the late_cycles row as paid_in_full and voids the draft notice when the lease is fully paid off (absent from outstandingBalances)", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "CHESAPEAKE-PAID", propertyId });
    const lateCycleId = await seedLateCycle(pool, { leaseId, deMinimisConfigId });
    const noticeId = await seedNotice(pool, { lateCycleId, leaseId, letterTemplateId, assignedPmId: pmId });

    // Lease is absent from outstandingBalances entirely — Buildium reports
    // zero/credit balance, exactly like the day-of-payment scenario reported.
    const result = await reconcileClosedCycles(pool, [], fakeGlAccountsById(), DE_MINIMIS_THRESHOLD, startTrace());

    expect(result.cyclesReconciled).toBe(1);
    expect(result.noticesAutoVoided).toBe(1);
    expect(result.errors).toEqual([]);

    const cycle = await pool.query("SELECT closed_at, closed_reason FROM late_cycles WHERE id = $1", [lateCycleId]);
    expect(cycle.rows[0].closed_at).not.toBeNull();
    expect(cycle.rows[0].closed_reason).toBe("paid_in_full");

    const notice = await pool.query("SELECT status, voided_reason FROM notices WHERE id = $1", [noticeId]);
    expect(notice.rows[0].status).toBe("voided");
    expect(notice.rows[0].voided_reason).toMatch(/rent is paid in full/i);
    // No non-rent fee involved in this scenario — no misleading "note" tacked on.
    expect(notice.rows[0].voided_reason).not.toMatch(/non-rent fees/i);
  });

  it("closes the late_cycles row as paid_below_threshold when the remaining balance is under the de minimis threshold", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "CHESAPEAKE-PARTIAL", propertyId });
    const lateCycleId = await seedLateCycle(pool, { leaseId, deMinimisConfigId });
    const noticeId = await seedNotice(pool, { lateCycleId, leaseId, letterTemplateId, assignedPmId: pmId });

    const result = await reconcileClosedCycles(
      pool,
      [fakeBalance("CHESAPEAKE-PARTIAL", 42)],
      fakeGlAccountsById(),
      DE_MINIMIS_THRESHOLD,
      startTrace()
    );

    expect(result.cyclesReconciled).toBe(1);
    expect(result.noticesAutoVoided).toBe(1);

    const cycle = await pool.query("SELECT closed_reason FROM late_cycles WHERE id = $1", [lateCycleId]);
    expect(cycle.rows[0].closed_reason).toBe("paid_below_threshold");

    const notice = await pool.query("SELECT status FROM notices WHERE id = $1", [noticeId]);
    expect(notice.rows[0].status).toBe("voided");
  });

  it("leaves the cycle open and the notice untouched when the lease is still genuinely past the threshold", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "STILL-LATE", propertyId });
    const lateCycleId = await seedLateCycle(pool, { leaseId, deMinimisConfigId });
    const noticeId = await seedNotice(pool, { lateCycleId, leaseId, letterTemplateId, assignedPmId: pmId });

    const result = await reconcileClosedCycles(
      pool,
      [fakeBalance("STILL-LATE", 1500)],
      fakeGlAccountsById(),
      DE_MINIMIS_THRESHOLD,
      startTrace()
    );

    expect(result.cyclesReconciled).toBe(0);
    expect(result.noticesAutoVoided).toBe(0);

    const cycle = await pool.query("SELECT closed_at FROM late_cycles WHERE id = $1", [lateCycleId]);
    expect(cycle.rows[0].closed_at).toBeNull();

    const notice = await pool.query("SELECT status FROM notices WHERE id = $1", [noticeId]);
    expect(notice.rows[0].status).toBe("draft");
  });

  // Direct regression coverage for Jason's 2026-08-14 report: 1318 River
  // Birch Run South and 1313 Tait Close both kept showing up as needing a
  // notice over an unpaid $300 "Lease Change Fee" — a real charge, but not
  // rent, and not something that should hold a case open.
  it("closes the cycle when the only remaining balance is a non-rent fee (e.g. a Lease Change Fee), even though the raw Buildium balance is still positive", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "LEASE-CHANGE-FEE-ONLY", propertyId });
    const lateCycleId = await seedLateCycle(pool, { leaseId, deMinimisConfigId });
    const noticeId = await seedNotice(pool, { lateCycleId, leaseId, letterTemplateId, assignedPmId: pmId });

    const leaseChangeFeeGlId = 857392;
    const glAccountsById: Map<number, BuildiumGlAccount> = new Map([
      [
        leaseChangeFeeGlId,
        {
          Id: leaseChangeFeeGlId,
          Name: "Lease Change Fee",
          Type: "Income",
          SubType: "Income",
          DefaultAccountName: null,
          IsDefaultGLAccount: false,
        },
      ],
    ]);
    const balance: LeaseBalance = {
      leaseId: "LEASE-CHANGE-FEE-ONLY",
      balance: 300,
      evictionPendingDate: null,
      balancesByGl: [{ glAccountId: leaseChangeFeeGlId, balance: 300 }],
    };

    const result = await reconcileClosedCycles(pool, [balance], glAccountsById, DE_MINIMIS_THRESHOLD, startTrace());

    expect(result.cyclesReconciled).toBe(1);
    expect(result.noticesAutoVoided).toBe(1);

    const cycle = await pool.query("SELECT closed_at, closed_reason FROM late_cycles WHERE id = $1", [lateCycleId]);
    expect(cycle.rows[0].closed_at).not.toBeNull();
    expect(cycle.rows[0].closed_reason).toBe("paid_in_full");

    const notice = await pool.query("SELECT status, voided_reason FROM notices WHERE id = $1", [noticeId]);
    expect(notice.rows[0].status).toBe("voided");
    // The reason text must not claim the full $300 was "paid in full" — it
    // wasn't paid at all, it just was never rent. TARS/Mason review finding
    // (2026-08-14): an unqualified "paid in full" here would be a
    // bookkeeping trap, telling a PM there's nothing left to collect.
    expect(notice.rows[0].voided_reason).toMatch(/rent is paid in full/i);
    expect(notice.rows[0].voided_reason).toMatch(/\$300\.00 in non-rent fees may still be outstanding/i);
  });

  // Found via live verification (2026-08-14, same day as this whole fix):
  // real leases 2114672/2579686/2624547 (1311 Tait Close, 2642 East Ocean
  // View Avenue, 2604 Greenwood Drive) each carry a small "Court Costs-
  // Tenant" charge — a GL account glClassification.ts deliberately refuses
  // to classify (legally out of scope for THIS table, reserved for the
  // later day-18 attorney-referral stage) rather than guess. Before this
  // fix, that only ever blocked DRAFTING; after adding classification to
  // reconciliation too, it started ALSO throwing here, generating a second,
  // redundant daily "ACTION NEEDED" alert for a problem Jason was already
  // being told about. Fixed: an unclassifiable charge during reconciliation
  // defers to the drafting step's own alert — the cycle just stays open,
  // silently, with no additional error.
  it("leaves the cycle open, without erroring, when the balance contains a charge that can't be classified (e.g. Court Costs) — defers to the drafting step's own alert", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "COURT-COSTS-BLOCKED", propertyId });
    const lateCycleId = await seedLateCycle(pool, { leaseId, deMinimisConfigId });
    const noticeId = await seedNotice(pool, { lateCycleId, leaseId, letterTemplateId, assignedPmId: pmId });

    const courtCostsGlId = 976019;
    const glAccountsById: Map<number, BuildiumGlAccount> = new Map([
      [
        courtCostsGlId,
        {
          Id: courtCostsGlId,
          Name: "Court Costs- Tenant",
          Type: "Income",
          SubType: "Income",
          DefaultAccountName: null,
          IsDefaultGLAccount: false,
        },
      ],
    ]);
    const balance: LeaseBalance = {
      leaseId: "COURT-COSTS-BLOCKED",
      balance: 64,
      evictionPendingDate: null,
      balancesByGl: [{ glAccountId: courtCostsGlId, balance: 64 }],
    };

    const result = await reconcileClosedCycles(pool, [balance], glAccountsById, DE_MINIMIS_THRESHOLD, startTrace());

    expect(result.cyclesReconciled).toBe(0);
    expect(result.errors).toEqual([]);

    const cycle = await pool.query("SELECT closed_at FROM late_cycles WHERE id = $1", [lateCycleId]);
    expect(cycle.rows[0].closed_at).toBeNull();

    const notice = await pool.query("SELECT status FROM notices WHERE id = $1", [noticeId]);
    expect(notice.rows[0].status).toBe("draft");
  });

  it("does NOT touch a notice that was already sent, even though its cycle still closes as paid", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "ALREADY-SENT", propertyId });
    const lateCycleId = await seedLateCycle(pool, { leaseId, deMinimisConfigId });
    const noticeId = await seedNotice(pool, {
      lateCycleId,
      leaseId,
      letterTemplateId,
      assignedPmId: pmId,
      status: "draft",
    });
    await pool.query(
      "UPDATE notices SET status = 'sent', sent_at = now(), ledger_verified = true WHERE id = $1",
      [noticeId]
    );

    const result = await reconcileClosedCycles(pool, [], fakeGlAccountsById(), DE_MINIMIS_THRESHOLD, startTrace());

    expect(result.cyclesReconciled).toBe(1); // the cycle itself still closes — the tenant did pay
    expect(result.noticesAutoVoided).toBe(0); // but the already-sent notice is a historical record, untouched

    const cycle = await pool.query("SELECT closed_reason FROM late_cycles WHERE id = $1", [lateCycleId]);
    expect(cycle.rows[0].closed_reason).toBe("paid_in_full");

    const notice = await pool.query("SELECT status FROM notices WHERE id = $1", [noticeId]);
    expect(notice.rows[0].status).toBe("sent");
  });

  it("ignores already-closed cycles (does not reprocess or double-count them)", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "ALREADY-CLOSED", propertyId });
    const lateCycleId = await seedLateCycle(pool, { leaseId, deMinimisConfigId });
    await pool.query("UPDATE late_cycles SET closed_at = now(), closed_reason = 'manual' WHERE id = $1", [
      lateCycleId,
    ]);

    const result = await reconcileClosedCycles(pool, [], fakeGlAccountsById(), DE_MINIMIS_THRESHOLD, startTrace());

    expect(result.cyclesReconciled).toBe(0);
    expect(result.noticesAutoVoided).toBe(0);

    const cycle = await pool.query("SELECT closed_reason FROM late_cycles WHERE id = $1", [lateCycleId]);
    expect(cycle.rows[0].closed_reason).toBe("manual"); // untouched, not overwritten to paid_in_full
  });
});
