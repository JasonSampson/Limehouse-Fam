import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestSuperuserPool, truncateAllTables, closeAllTestPools } from "../support/testDb.js";
import { seedPmUser, seedProperty, seedLease } from "../support/seed.js";

// contact_attempts.promised_pay_date CHECK constraint (migration 0024):
//   outcome != 'promised_to_pay' OR promised_pay_date IS NOT NULL
// i.e. you cannot log a "tenant promised to pay" outcome without also
// recording the date they promised to pay by. Tested at the DB layer
// directly (superuser connection, RLS irrelevant here — this is a table
// CHECK constraint, not a policy) since that's where the constraint lives
// and where it must hold regardless of which role/RLS path an INSERT comes
// through.
describe("contact_attempts.ck_contact_attempts_promised_pay_date_required", () => {
  const pool = getTestSuperuserPool();
  let pmId: number;
  let leaseId: number;

  beforeAll(async () => {
    await truncateAllTables();
    pmId = await seedPmUser(pool, { email: "pm@limehousepm.com" });
    const propertyId = await seedProperty(pool, { buildiumPropertyId: "PROP-CA" });
    leaseId = await seedLease(pool, { buildiumLeaseId: "LEASE-CA", propertyId });
  });

  afterAll(async () => {
    await closeAllTestPools();
  });

  it("rejects outcome='promised_to_pay' with a NULL promised_pay_date", async () => {
    await expect(
      pool.query(
        `INSERT INTO contact_attempts (lease_id, logged_by_pm_id, contact_method, outcome, promised_pay_date)
         VALUES ($1, $2, 'phone', 'promised_to_pay', NULL)`,
        [leaseId, pmId]
      )
    ).rejects.toThrow(/ck_contact_attempts_promised_pay_date_required/);
  });

  it("accepts outcome='promised_to_pay' when promised_pay_date IS provided", async () => {
    const result = await pool.query(
      `INSERT INTO contact_attempts (lease_id, logged_by_pm_id, contact_method, outcome, promised_pay_date)
       VALUES ($1, $2, 'phone', 'promised_to_pay', '2026-07-20') RETURNING id`,
      [leaseId, pmId]
    );
    expect(result.rows).toHaveLength(1);
  });

  it("accepts any other outcome with a NULL promised_pay_date (constraint doesn't apply)", async () => {
    const result = await pool.query(
      `INSERT INTO contact_attempts (lease_id, logged_by_pm_id, contact_method, outcome, promised_pay_date)
       VALUES ($1, $2, 'phone', 'reached_tenant', NULL) RETURNING id`,
      [leaseId, pmId]
    );
    expect(result.rows).toHaveLength(1);
  });

  it("accepts any other outcome even if a promised_pay_date happens to be set (constraint is one-directional)", async () => {
    const result = await pool.query(
      `INSERT INTO contact_attempts (lease_id, logged_by_pm_id, contact_method, outcome, promised_pay_date)
       VALUES ($1, $2, 'phone', 'disputed_charge', '2026-08-01') RETURNING id`,
      [leaseId, pmId]
    );
    expect(result.rows).toHaveLength(1);
  });

  it("rejects an outcome value outside the allowed set (ck_contact_attempts_outcome)", async () => {
    await expect(
      pool.query(
        `INSERT INTO contact_attempts (lease_id, logged_by_pm_id, contact_method, outcome)
         VALUES ($1, $2, 'phone', 'ghosted_us')`,
        [leaseId, pmId]
      )
    ).rejects.toThrow(/ck_contact_attempts_outcome/);
  });

  it("rejects a contact_method value outside the allowed set (ck_contact_attempts_contact_method)", async () => {
    await expect(
      pool.query(
        `INSERT INTO contact_attempts (lease_id, logged_by_pm_id, contact_method, outcome)
         VALUES ($1, $2, 'carrier_pigeon', 'reached_tenant')`,
        [leaseId, pmId]
      )
    ).rejects.toThrow(/ck_contact_attempts_contact_method/);
  });
});
