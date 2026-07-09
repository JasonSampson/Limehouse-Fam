import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getTestSuperuserPool, truncateAllTables, closeAllTestPools } from "../support/testDb.js";
import { resolveLateCycleId } from "../../src/jobs/dailyLatenessCheck.js";
import { startTrace } from "../../src/lib/trace.js";
import { seedPmUser, seedProperty, seedLease, seedActiveConfigValue } from "../support/seed.js";

// Root cause of the bug Jason reported (an NSF-bounced payment never
// generating a fresh notice) and its fix: once a late_cycles row is closed
// (tenant appeared to pay) and its notice voided, nothing previously ever
// reopened it if that payment later reversed — the tenant could go a full
// rent cycle with a real, currently-owed debt completely unflagged.
// resolveLateCycleId (migration 0042) is the fix: it's called once per
// qualifying lease per day and decides whether to use the existing open
// cycle, start a brand-new first-ever cycle, or REOPEN a closed one as a
// new attempt — without ever touching the closed row, which stays exactly
// as it was, permanently, as audit history.
describe("resolveLateCycleId", () => {
  const pool = getTestSuperuserPool();
  let pmId: number;
  let propertyId: number;
  let deMinimisConfigId: number;

  beforeEach(async () => {
    await truncateAllTables();
    pmId = await seedPmUser(pool, { email: "resolve-cycle-test@limehousepm.com" });
    propertyId = await seedProperty(pool, { buildiumPropertyId: "PROP-RESOLVE-CYCLE" });
    deMinimisConfigId = await seedActiveConfigValue(pool, {
      configKey: "de_minimis_threshold_usd",
      value: 100,
      setByPmId: pmId,
    });
  });

  afterAll(async () => {
    await closeAllTestPools();
  });

  it("creates a brand-new cycle_attempt=1 row when no cycle exists yet for this lease+due_date", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "FIRST-EVER", propertyId });

    const id = await resolveLateCycleId(pool, {
      leaseId,
      propertyId,
      dueDateStr: "2026-07-01",
      deMinimisConfigId,
      trace: startTrace(),
    });

    const row = await pool.query("SELECT cycle_attempt, reopened_from_cycle_id, closed_at FROM late_cycles WHERE id = $1", [id]);
    expect(row.rows[0].cycle_attempt).toBe(1);
    expect(row.rows[0].reopened_from_cycle_id).toBeNull();
    expect(row.rows[0].closed_at).toBeNull();
  });

  it("is idempotent: a same-day re-run for the same lease+due_date returns the same still-open cycle, not a duplicate", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "IDEMPOTENT", propertyId });
    const first = await resolveLateCycleId(pool, {
      leaseId,
      propertyId,
      dueDateStr: "2026-07-01",
      deMinimisConfigId,
      trace: startTrace(),
    });
    const second = await resolveLateCycleId(pool, {
      leaseId,
      propertyId,
      dueDateStr: "2026-07-01",
      deMinimisConfigId,
      trace: startTrace(),
    });

    expect(second).toBe(first);
    const count = await pool.query("SELECT count(*) FROM late_cycles WHERE lease_id = $1", [leaseId]);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it("reopens a closed cycle as a new attempt when the tenant is delinquent again for the same due date — the NSF-bounce scenario", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "NSF-BOUNCE", propertyId });
    const originalId = await resolveLateCycleId(pool, {
      leaseId,
      propertyId,
      dueDateStr: "2026-06-01",
      deMinimisConfigId,
      trace: startTrace(),
    });
    // Simulate reconcileClosedCycles having closed it as paid.
    await pool.query("UPDATE late_cycles SET closed_at = now(), closed_reason = 'paid_in_full' WHERE id = $1", [
      originalId,
    ]);

    // Days later, the payment bounces — the tenant is delinquent again for
    // the SAME due date.
    const reopenedId = await resolveLateCycleId(pool, {
      leaseId,
      propertyId,
      dueDateStr: "2026-06-01",
      deMinimisConfigId,
      trace: startTrace(),
    });

    expect(reopenedId).not.toBe(originalId);

    const reopenedRow = await pool.query(
      "SELECT cycle_attempt, reopened_from_cycle_id, closed_at FROM late_cycles WHERE id = $1",
      [reopenedId]
    );
    expect(reopenedRow.rows[0].cycle_attempt).toBe(2);
    expect(Number(reopenedRow.rows[0].reopened_from_cycle_id)).toBe(originalId);
    expect(reopenedRow.rows[0].closed_at).toBeNull();

    // The original closed row is untouched — permanent audit history.
    const originalRow = await pool.query("SELECT closed_at, closed_reason, cycle_attempt FROM late_cycles WHERE id = $1", [
      originalId,
    ]);
    expect(originalRow.rows[0].closed_at).not.toBeNull();
    expect(originalRow.rows[0].closed_reason).toBe("paid_in_full");
    expect(originalRow.rows[0].cycle_attempt).toBe(1);
  });

  it("writes an audit_log entry when reopening, referencing both the old and new cycle ids", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "NSF-AUDIT", propertyId });
    const originalId = await resolveLateCycleId(pool, {
      leaseId,
      propertyId,
      dueDateStr: "2026-06-01",
      deMinimisConfigId,
      trace: startTrace(),
    });
    await pool.query("UPDATE late_cycles SET closed_at = now(), closed_reason = 'paid_in_full' WHERE id = $1", [
      originalId,
    ]);
    const reopenedId = await resolveLateCycleId(pool, {
      leaseId,
      propertyId,
      dueDateStr: "2026-06-01",
      deMinimisConfigId,
      trace: startTrace(),
    });

    const auditRows = await pool.query(
      "SELECT event_type, event_data FROM audit_log WHERE event_type = 'late_cycle.reopened' ORDER BY id DESC LIMIT 1"
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].event_data.previousCycleId).toBe(originalId);
    expect(auditRows.rows[0].event_data.newCycleId).toBe(reopenedId);
    expect(auditRows.rows[0].event_data.cycleAttempt).toBe(2);
  });

  it("allows a second reopen (cycle_attempt=3) if the tenant bounces again after the second attempt is also closed", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "NSF-TWICE", propertyId });
    const first = await resolveLateCycleId(pool, {
      leaseId,
      propertyId,
      dueDateStr: "2026-05-01",
      deMinimisConfigId,
      trace: startTrace(),
    });
    await pool.query("UPDATE late_cycles SET closed_at = now(), closed_reason = 'paid_in_full' WHERE id = $1", [first]);
    const second = await resolveLateCycleId(pool, {
      leaseId,
      propertyId,
      dueDateStr: "2026-05-01",
      deMinimisConfigId,
      trace: startTrace(),
    });
    await pool.query("UPDATE late_cycles SET closed_at = now(), closed_reason = 'paid_in_full' WHERE id = $1", [second]);
    const third = await resolveLateCycleId(pool, {
      leaseId,
      propertyId,
      dueDateStr: "2026-05-01",
      deMinimisConfigId,
      trace: startTrace(),
    });

    const thirdRow = await pool.query("SELECT cycle_attempt, reopened_from_cycle_id FROM late_cycles WHERE id = $1", [
      third,
    ]);
    expect(thirdRow.rows[0].cycle_attempt).toBe(3);
    expect(Number(thirdRow.rows[0].reopened_from_cycle_id)).toBe(second);

    const total = await pool.query("SELECT count(*) FROM late_cycles WHERE lease_id = $1", [leaseId]);
    expect(Number(total.rows[0].count)).toBe(3);
  });

  it("only one OPEN cycle per lease+due_date can exist at a time (partial unique index enforced)", async () => {
    const leaseId = await seedLease(pool, { buildiumLeaseId: "ONE-OPEN-ONLY", propertyId });
    await resolveLateCycleId(pool, {
      leaseId,
      propertyId,
      dueDateStr: "2026-07-01",
      deMinimisConfigId,
      trace: startTrace(),
    });

    // Directly attempting to insert a second OPEN cycle for the same
    // lease+due_date (bypassing resolveLateCycleId, which never does this
    // itself) must be rejected by the DB-level invariant, not just
    // application logic.
    await expect(
      pool.query(
        `INSERT INTO late_cycles (lease_id, due_date, de_minimis_config_id, opened_at, cycle_attempt)
         VALUES ($1, $2, $3, now(), 2)`,
        [leaseId, "2026-07-01", deMinimisConfigId]
      )
    ).rejects.toThrow(/idx_late_cycles_one_open_per_due_date/);
  });
});
