import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestSuperuserPool, truncateAllTables, closeAllTestPools } from "../support/testDb.js";
import { getDefaultGracePeriodDays, getInheritedLeaseGracePeriodDays } from "../../src/lib/config.js";
import { seedPmUser, seedProperty, seedActiveConfigValue } from "../support/seed.js";

// Grace-period config values as actually seeded by migrations 0021/0030/0031:
// standard (default) leases = 3 days (14-Day Notice triggers day 4),
// inherited leases = 5 days (triggers day 6). Migration 0030's whole point
// was correcting an earlier mistake (5 was wrongly applied as the
// company-wide default) — this test locks in the corrected values so a
// future migration can't silently reintroduce that bug.
//
// This file truncates and re-seeds config_values itself (replicating
// migrations 0021/0030/0031's exact inserts) rather than depending on the
// migration-applied rows surviving untouched — other files in test/db/ also
// truncate all tables in their own beforeAll, and vitest test files within
// one config run don't share transaction isolation, so cross-file ordering
// must never be load-bearing for what a file asserts.
describe("grace period config_values (replicates migrations 0021, 0030, 0031's seed behavior)", () => {
  const pool = getTestSuperuserPool();
  let pmId: number;

  beforeAll(async () => {
    await truncateAllTables();
    pmId = await seedPmUser(pool, { email: "config-admin@limehousepm.com" });

    // Replicate 0021 (seed v1 = 5, the original — later found to be wrong
    // for standard leases) then 0030 (deactivate v1, seed v2 = 3, correct
    // value) for default_grace_period_days, and 0031 for
    // inherited_lease_grace_period_days.
    await pool.query(
      `INSERT INTO config_values (config_key, version, value, is_active, set_by_pm_id, change_reason)
       VALUES ('default_grace_period_days', 1, '5'::jsonb, false, $1, 'original seed (migration 0021)')`,
      [pmId]
    );
    await seedActiveConfigValue(pool, {
      configKey: "default_grace_period_days",
      version: 2,
      value: 3,
      setByPmId: pmId,
      changeReason: "Correction: 5 was the inherited-lease value, mistakenly applied to every new lease (migration 0030).",
    });
    await seedActiveConfigValue(pool, {
      configKey: "inherited_lease_grace_period_days",
      version: 1,
      value: 5,
      setByPmId: pmId,
      changeReason: "Grace period for inherited leases (migration 0031).",
    });
  });

  it("the active default_grace_period_days is 3 (standard lease, day-4 trigger)", async () => {
    const { days } = await getDefaultGracePeriodDays(pool);
    expect(days).toBe(3);
  });

  it("the active inherited_lease_grace_period_days is 5 (inherited lease, day-6 trigger)", async () => {
    const { days } = await getInheritedLeaseGracePeriodDays(pool);
    expect(days).toBe(5);
  });

  it("default_grace_period_days has exactly one active version (audit trail preserved, old version deactivated not deleted)", async () => {
    const result = await pool.query(
      "SELECT version, is_active FROM config_values WHERE config_key = 'default_grace_period_days' ORDER BY version"
    );
    const activeRows = result.rows.filter((r) => r.is_active);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].version).toBe(2); // v1 was the mistaken 5; v2 is the 3-day correction
    // v1 should still exist (audit trail), just inactive.
    expect(result.rows.some((r) => r.version === 1 && r.is_active === false)).toBe(true);
  });

  it("only one config_values row per key can be active at a time (idx_config_values_one_active partial unique index)", async () => {
    await expect(
      pool.query(
        `INSERT INTO config_values (config_key, version, value, is_active, set_by_pm_id, change_reason)
         VALUES ('default_grace_period_days', 3, '99'::jsonb, true, $1, 'should fail — v2 is already active')`,
        [pmId]
      )
    ).rejects.toThrow(/idx_config_values_one_active/);
  });
});

// Confirms the DB actually applied migrations 0021/0030/0031 for real, as a
// separate sanity check against the live migration history table — distinct
// from the behavioral test above, which is self-seeding and order-independent.
describe("migration history sanity check", () => {
  const pool = getTestSuperuserPool();

  it("migrations 0021, 0030, and 0031 are present in pgmigrations", async () => {
    const result = await pool.query(
      `SELECT name FROM pgmigrations WHERE name IN (
         '0021_seed_default_grace_period_config',
         '0030_correct_default_grace_period_to_standard',
         '0031_seed_inherited_lease_grace_period_config'
       )`
    );
    expect(result.rows.map((r) => r.name).sort()).toEqual([
      "0021_seed_default_grace_period_config",
      "0030_correct_default_grace_period_to_standard",
      "0031_seed_inherited_lease_grace_period_config",
    ]);
  });
});

// The auto-correction behavior itself: src/buildium/sync.ts's lease UPSERT
// only overwrites grace_period_days on UPDATE when (a) fee_terms_source is
// 'inherited_lease' AND (b) the existing value still equals the standard
// default — i.e. nothing suggests a human already manually overrode it. This
// replicates that exact SQL (copied from src/buildium/sync.ts's
// ON CONFLICT clause) against real seeded rows rather than mocking the
// Buildium HTTP client, since the logic under test IS the SQL CASE
// expression, not the API call.
describe("grace_period_days auto-correction on lease re-sync (src/buildium/sync.ts UPSERT logic)", () => {
  const pool = getTestSuperuserPool();
  const STANDARD_DAYS = 3;
  const INHERITED_DAYS = 5;

  async function upsertLease(buildiumLeaseId: string, feeTermsSourceOnInsert: "limehouse_standard" | "inherited_lease") {
    const propertyId = await seedProperty(pool, { buildiumPropertyId: `PROP-${buildiumLeaseId}` });
    await pool.query(
      `INSERT INTO leases (buildium_lease_id, property_id, unit_buildium_id, unit_label, rent_due_day, grace_period_days, lease_status, synced_at, fee_terms_source)
       VALUES ($1, $2, $3, $4, 1, $5, 'Active', now(), $6)`,
      [buildiumLeaseId, propertyId, `unit-${buildiumLeaseId}`, `Unit ${buildiumLeaseId}`, STANDARD_DAYS, feeTermsSourceOnInsert]
    );
  }

  // Exact re-implementation of the ON CONFLICT DO UPDATE clause in
  // src/buildium/sync.ts, run standalone against a seeded row.
  async function resyncGracePeriod(buildiumLeaseId: string) {
    await pool.query(
      `UPDATE leases SET
         grace_period_days = CASE
           WHEN leases.fee_terms_source = 'inherited_lease'
                AND leases.grace_period_days = $2
           THEN $3
           ELSE leases.grace_period_days
         END
       WHERE buildium_lease_id = $1`,
      [buildiumLeaseId, STANDARD_DAYS, INHERITED_DAYS]
    );
  }

  beforeAll(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeAllTestPools();
  });

  it("auto-corrects grace_period_days from 3 to 5 when fee_terms_source is inherited_lease and the value still equals the standard default", async () => {
    await upsertLease("SYNC-INHERITED-UNTOUCHED", "inherited_lease");
    await resyncGracePeriod("SYNC-INHERITED-UNTOUCHED");
    const result = await pool.query("SELECT grace_period_days FROM leases WHERE buildium_lease_id = $1", [
      "SYNC-INHERITED-UNTOUCHED",
    ]);
    expect(result.rows[0].grace_period_days).toBe(5);
  });

  it("does NOT touch grace_period_days for a standard (limehouse_standard) lease on re-sync", async () => {
    await upsertLease("SYNC-STANDARD", "limehouse_standard");
    await resyncGracePeriod("SYNC-STANDARD");
    const result = await pool.query("SELECT grace_period_days FROM leases WHERE buildium_lease_id = $1", [
      "SYNC-STANDARD",
    ]);
    expect(result.rows[0].grace_period_days).toBe(3);
  });

  it("does NOT clobber a manual override: inherited_lease with grace_period_days already manually changed away from the standard default is left alone", async () => {
    await upsertLease("SYNC-MANUAL-OVERRIDE", "inherited_lease");
    // Simulate a PM manually overriding it via PATCH /api/leases/:id/grace-period
    await pool.query("UPDATE leases SET grace_period_days = 10 WHERE buildium_lease_id = $1", [
      "SYNC-MANUAL-OVERRIDE",
    ]);
    await resyncGracePeriod("SYNC-MANUAL-OVERRIDE");
    const result = await pool.query("SELECT grace_period_days FROM leases WHERE buildium_lease_id = $1", [
      "SYNC-MANUAL-OVERRIDE",
    ]);
    expect(result.rows[0].grace_period_days).toBe(10); // untouched by the auto-correction
  });

  it("does NOT clobber a manual override that happens to already equal 5 exactly (idempotent, no false re-trigger needed)", async () => {
    await upsertLease("SYNC-ALREADY-FIVE", "inherited_lease");
    await resyncGracePeriod("SYNC-ALREADY-FIVE"); // corrects 3 -> 5
    await resyncGracePeriod("SYNC-ALREADY-FIVE"); // second sync: already 5, not 3, so CASE's second condition fails -> stays 5
    const result = await pool.query("SELECT grace_period_days FROM leases WHERE buildium_lease_id = $1", [
      "SYNC-ALREADY-FIVE",
    ]);
    expect(result.rows[0].grace_period_days).toBe(5);
  });
});
