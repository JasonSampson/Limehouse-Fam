import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getTestSuperuserPool, truncateAllTables, closeAllTestPools } from "../support/testDb.js";
import { reconcileClosedCycles } from "../../src/jobs/dailyLatenessCheck.js";
import { startTrace } from "../../src/lib/trace.js";
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
    const result = await reconcileClosedCycles(pool, [], DE_MINIMIS_THRESHOLD, startTrace());

    expect(result.cyclesReconciled).toBe(1);
    expect(result.noticesAutoVoided).toBe(1);
    expect(result.errors).toEqual([]);

    const cycle = await pool.query("SELECT closed_at, closed_reason FROM late_cycles WHERE id = $1", [lateCycleId]);
    expect(cycle.rows[0].closed_at).not.toBeNull();
    expect(cycle.rows[0].closed_reason).toBe("paid_in_full");

    const notice = await pool.query("SELECT status, voided_reason FROM notices WHERE id = $1", [noticeId]);
    expect(notice.rows[0].status).toBe("voided");
    expect(notice.rows[0].voided_reason).toMatch(/paid the balance in full/i);
  });

  it("closes the late_cycles row as paid_below_threshold when the remaining balance is under the de minimis threshold", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "CHESAPEAKE-PARTIAL", propertyId });
    const lateCycleId = await seedLateCycle(pool, { leaseId, deMinimisConfigId });
    const noticeId = await seedNotice(pool, { lateCycleId, leaseId, letterTemplateId, assignedPmId: pmId });

    const result = await reconcileClosedCycles(
      pool,
      [{ leaseId: "CHESAPEAKE-PARTIAL", balance: 42 }],
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
      [{ leaseId: "STILL-LATE", balance: 1500 }],
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

    const result = await reconcileClosedCycles(pool, [], DE_MINIMIS_THRESHOLD, startTrace());

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

    const result = await reconcileClosedCycles(pool, [], DE_MINIMIS_THRESHOLD, startTrace());

    expect(result.cyclesReconciled).toBe(0);
    expect(result.noticesAutoVoided).toBe(0);

    const cycle = await pool.query("SELECT closed_reason FROM late_cycles WHERE id = $1", [lateCycleId]);
    expect(cycle.rows[0].closed_reason).toBe("manual"); // untouched, not overwritten to paid_in_full
  });
});
