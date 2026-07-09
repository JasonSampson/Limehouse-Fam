import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestAppPool, getTestSuperuserPool, withTestPmScope, truncateAllTables, closeAllTestPools } from "../support/testDb.js";
import { seedPmUser, seedProperty, seedPmPropertyAssignment, seedLease } from "../support/seed.js";

// Migration 0043: a property with ZERO pm_property_assignments rows becomes
// visible to every signed-in PM (any role) — Jason's fix for "a genuinely
// delinquent tenant on a not-yet-assigned property is invisible to
// everyone, including me." Confirms the exception is narrow: it does NOT
// weaken door-scoping for properties that DO have an assignment, and the
// write side (pm_property_assignments) is now INSERT-only for the app role
// (Sentinel's finding — see migration 0043's comment).
describe("Unassigned-property visibility (migration 0043)", () => {
  const superuser = getTestSuperuserPool();
  const appPool = getTestAppPool();

  let pmA: number; // assigned to propertyAssigned
  let pmB: number; // assigned to nothing
  let propertyAssigned: number;
  let propertyUnassigned: number;
  let leaseOnAssignedProperty: number;
  let leaseOnUnassignedProperty: number;

  beforeAll(async () => {
    await truncateAllTables();
    pmA = await seedPmUser(superuser, { email: "pma-visibility@limehousepm.com", role: "pm" });
    pmB = await seedPmUser(superuser, { email: "pmb-visibility@limehousepm.com", role: "pm" });

    propertyAssigned = await seedProperty(superuser, { buildiumPropertyId: "PROP-ASSIGNED", name: "Assigned Court" });
    propertyUnassigned = await seedProperty(superuser, { buildiumPropertyId: "PROP-UNASSIGNED", name: "Unassigned Court" });
    await seedPmPropertyAssignment(superuser, pmA, propertyAssigned);
    // propertyUnassigned deliberately gets NO pm_property_assignments row.

    leaseOnAssignedProperty = await seedLease(superuser, { buildiumLeaseId: "LEASE-ASSIGNED", propertyId: propertyAssigned });
    leaseOnUnassignedProperty = await seedLease(superuser, { buildiumLeaseId: "LEASE-UNASSIGNED", propertyId: propertyUnassigned });
  });

  afterAll(async () => {
    await closeAllTestPools();
  });

  it("a PM with no assignment anywhere CAN see a lease on a property with zero assignments", async () => {
    const rows = await withTestPmScope({ pmUserId: pmB, pmRole: "pm" }, (client) =>
      client.query("SELECT id FROM leases WHERE id = $1", [leaseOnUnassignedProperty])
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("a PM still CANNOT see a lease on a property assigned to someone else", async () => {
    const rows = await withTestPmScope({ pmUserId: pmB, pmRole: "pm" }, (client) =>
      client.query("SELECT id FROM leases WHERE id = $1", [leaseOnAssignedProperty])
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("once a property gets an assignment, it reverts to normal door-scoping — no longer visible to an unrelated PM", async () => {
    await superuser.query(
      `INSERT INTO pm_property_assignments (pm_user_id, property_id, source, synced_at) VALUES ($1, $2, 'manual_app_assignment', now())`,
      [pmA, propertyUnassigned]
    );

    const stillVisibleToOwner = await withTestPmScope({ pmUserId: pmA, pmRole: "pm" }, (client) =>
      client.query("SELECT id FROM leases WHERE id = $1", [leaseOnUnassignedProperty])
    );
    expect(stillVisibleToOwner.rows).toHaveLength(1);

    const noLongerVisibleToOthers = await withTestPmScope({ pmUserId: pmB, pmRole: "pm" }, (client) =>
      client.query("SELECT id FROM leases WHERE id = $1", [leaseOnUnassignedProperty])
    );
    expect(noLongerVisibleToOthers.rows).toHaveLength(0);

    // Clean up so later tests in this file still see propertyUnassigned as unassigned.
    await superuser.query("DELETE FROM pm_property_assignments WHERE property_id = $1 AND pm_user_id = $2", [
      propertyUnassigned,
      pmA,
    ]);
  });

  it("the app role can no longer UPDATE pm_property_assignments (Sentinel finding — insert-only now)", async () => {
    const existing = await superuser.query(
      "SELECT id FROM pm_property_assignments WHERE property_id = $1 AND pm_user_id = $2",
      [propertyAssigned, pmA]
    );
    await expect(
      appPool.query("UPDATE pm_property_assignments SET source = 'tampered' WHERE id = $1", [existing.rows[0].id])
    ).rejects.toThrow(/permission denied/i);
  });

  it("the app role can still INSERT a new pm_property_assignments row (the actual assign-a-PM flow)", async () => {
    const result = await appPool.query<{ id: number }>(
      `INSERT INTO pm_property_assignments (pm_user_id, property_id, source, synced_at)
       VALUES ($1, $2, 'manual_app_assignment', now()) RETURNING id`,
      [pmB, propertyUnassigned]
    );
    expect(result.rows).toHaveLength(1);
    await superuser.query("DELETE FROM pm_property_assignments WHERE id = $1", [result.rows[0].id]);
  });
});
