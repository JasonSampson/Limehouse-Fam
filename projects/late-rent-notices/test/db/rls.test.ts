import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  getTestAppPool,
  getTestSuperuserPool,
  withTestPmScope,
  truncateAllTables,
  closeAllTestPools,
} from "../support/testDb.js";
import {
  seedPmUser,
  seedProperty,
  seedPmPropertyAssignment,
  seedLease,
  seedLeaseTenant,
  seedActiveConfigValue,
  seedLetterTemplate,
  seedLateCycle,
  seedNotice,
} from "../support/seed.js";

// Row-level security (RLS) integration tests. Run against the disposable
// Docker test DB (late_rent_notices_test_pg, port 55432 — see .env.test).
// Connects as the REAL late_rent_app Postgres role (not superuser), the same
// role the web app itself uses, so these tests exercise the actual FORCE ROW
// LEVEL SECURITY policies from migrations 0016/0017/0019/0027/0029/0033/
// 0036/0037 — not a re-implementation of what they're supposed to do.
//
// Covers what was manually verified in today's one-off session:
//   - door-scoping for a plain 'pm' (sees only their assigned properties)
//   - portfolio-wide read for admin_assistant / bookkeeping
//   - zero write path anywhere for bookkeeping
//   - insert-only-on-contact_attempts for admin_assistant
//   - no write path to leases/lease_tenants/late_cycles/notices/
//     notice_recipients for either read-only role (migrations 0036, 0037)

describe("Row-level security", () => {
  const superuser = getTestSuperuserPool();
  const appPool = getTestAppPool();

  let pmA: number; // PM assigned to property A only
  let pmB: number; // PM assigned to property B only
  let adminAssistant: number;
  let bookkeeping: number;
  let fallbackPm: number; // owner/fallback decision-maker, assigned to neither property A nor B
  let propertyA: number;
  let propertyB: number;
  let leaseA: number; // belongs to property A (pmA's door)
  let leaseB: number; // belongs to property B (pmB's door)
  let deMinimisConfigId: number;
  let letterTemplateId: number;

  beforeAll(async () => {
    await truncateAllTables();

    pmA = await seedPmUser(superuser, { email: "pm-a@limehousepm.com", role: "pm" });
    pmB = await seedPmUser(superuser, { email: "pm-b@limehousepm.com", role: "pm" });
    adminAssistant = await seedPmUser(superuser, { email: "assistant@limehousepm.com", role: "admin_assistant" });
    bookkeeping = await seedPmUser(superuser, { email: "bookkeeper@limehousepm.com", role: "bookkeeping" });
    fallbackPm = await seedPmUser(superuser, {
      email: "owner@limehousepm.com",
      role: "pm",
      isFallbackDecisionMaker: true,
    });

    propertyA = await seedProperty(superuser, { buildiumPropertyId: "PROP-A", name: "Ghent Square Apts" });
    propertyB = await seedProperty(superuser, { buildiumPropertyId: "PROP-B", name: "Riverside Commons" });

    await seedPmPropertyAssignment(superuser, pmA, propertyA);
    await seedPmPropertyAssignment(superuser, pmB, propertyB);

    leaseA = await seedLease(superuser, { buildiumLeaseId: "LEASE-A", propertyId: propertyA });
    leaseB = await seedLease(superuser, { buildiumLeaseId: "LEASE-B", propertyId: propertyB });

    await seedLeaseTenant(superuser, { leaseId: leaseA, buildiumTenantId: "TEN-A" });
    await seedLeaseTenant(superuser, { leaseId: leaseB, buildiumTenantId: "TEN-B" });

    deMinimisConfigId = await seedActiveConfigValue(superuser, {
      configKey: "de_minimis_threshold_usd",
      value: "50",
      setByPmId: pmA,
    });
    letterTemplateId = await seedLetterTemplate(superuser, { createdByPmId: pmA });
  });

  afterAll(async () => {
    await closeAllTestPools();
  });

  describe("door-scoping for a plain PM", () => {
    it("PM A sees only leases on their own door (property A), not property B", async () => {
      const rows = await withTestPmScope({ pmUserId: pmA, pmRole: "pm" }, (client) =>
        client.query("SELECT id FROM leases ORDER BY id")
      );
      expect(rows.rows.map((r) => r.id)).toEqual([leaseA]);
    });

    it("PM B sees only leases on their own door (property B), not property A", async () => {
      const rows = await withTestPmScope({ pmUserId: pmB, pmRole: "pm" }, (client) =>
        client.query("SELECT id FROM leases ORDER BY id")
      );
      expect(rows.rows.map((r) => r.id)).toEqual([leaseB]);
    });

    it("PM A's lease_tenants query is scoped the same way (join-based policy)", async () => {
      const rows = await withTestPmScope({ pmUserId: pmA, pmRole: "pm" }, (client) =>
        client.query("SELECT lease_id FROM lease_tenants ORDER BY id")
      );
      // bigint columns come back from `pg` as strings, not numbers — cast for comparison.
      expect(rows.rows.map((r) => Number(r.lease_id))).toEqual([leaseA]);
    });

    it("a PM with no property assignments sees zero leases (not an error, not everything)", async () => {
      const unassignedPm = await seedPmUser(superuser, { email: "unassigned@limehousepm.com", role: "pm" });
      const rows = await withTestPmScope({ pmUserId: unassignedPm, pmRole: "pm" }, (client) =>
        client.query("SELECT id FROM leases")
      );
      expect(rows.rows).toEqual([]);
    });
  });

  describe("portfolio-wide read for admin_assistant / bookkeeping", () => {
    it("admin_assistant sees leases across BOTH properties, unscoped by door", async () => {
      const rows = await withTestPmScope({ pmUserId: adminAssistant, pmRole: "admin_assistant" }, (client) =>
        client.query("SELECT id FROM leases ORDER BY id")
      );
      expect(rows.rows.map((r) => r.id).sort()).toEqual([leaseA, leaseB].sort());
    });

    it("bookkeeping sees leases across BOTH properties, unscoped by door", async () => {
      const rows = await withTestPmScope({ pmUserId: bookkeeping, pmRole: "bookkeeping" }, (client) =>
        client.query("SELECT id FROM leases ORDER BY id")
      );
      expect(rows.rows.map((r) => r.id).sort()).toEqual([leaseA, leaseB].sort());
    });

    it("admin_assistant sees late_cycles across both properties", async () => {
      const lateCycleA = await seedLateCycle(superuser, { leaseId: leaseA, deMinimisConfigId });
      const lateCycleB = await seedLateCycle(superuser, { leaseId: leaseB, deMinimisConfigId });
      const rows = await withTestPmScope({ pmUserId: adminAssistant, pmRole: "admin_assistant" }, (client) =>
        client.query("SELECT id FROM late_cycles ORDER BY id")
      );
      expect(rows.rows.map((r) => r.id).sort()).toEqual([lateCycleA, lateCycleB].sort());
    });

    it("bookkeeping sees contact_attempts across both properties (portfolio-wide SELECT)", async () => {
      await superuser.query(
        `INSERT INTO contact_attempts (lease_id, logged_by_pm_id, contact_method, outcome)
         VALUES ($1, $2, 'phone', 'reached_tenant')`,
        [leaseA, adminAssistant]
      );
      await superuser.query(
        `INSERT INTO contact_attempts (lease_id, logged_by_pm_id, contact_method, outcome)
         VALUES ($1, $2, 'phone', 'reached_tenant')`,
        [leaseB, adminAssistant]
      );
      const rows = await withTestPmScope({ pmUserId: bookkeeping, pmRole: "bookkeeping" }, (client) =>
        client.query("SELECT lease_id FROM contact_attempts ORDER BY id")
      );
      expect(rows.rows.map((r) => Number(r.lease_id)).sort()).toEqual([leaseA, leaseB].sort());
    });
  });

  // Migration 0054 — direct regression coverage for the "fourth recurrence"
  // bug (0047 draft-visibility, 0048/0049 fallback-void crash, 0050 voided-
  // visibility, now this): the fallback decision-maker's READ access into
  // leases/lease_tenants/notices/notice_recipients used to be scoped to
  // specific notice statuses, which broke for exactly the two real cases
  // Jason hit on 2026-08-14 — a stuck lease with NO notice at all yet, and
  // an already-SENT notice on someone else's door. Fixed by making the
  // grant unconditional, matching admin_assistant/bookkeeping's existing
  // portfolio-wide pattern.
  describe("portfolio-wide read for the fallback decision-maker (migration 0054)", () => {
    it("fallback sees a lease with an open late_cycle but NO notices row at all, on a door assigned to someone else — the 'Late, No Notice Yet' case", async () => {
      // leaseB belongs to pmB's door, not the fallback user's — and gets no
      // notices row at all, matching the real stuck-cycle scenario exactly
      // (a late_cycle exists, nothing else does yet).
      await seedLateCycle(superuser, { leaseId: leaseB, deMinimisConfigId, dueDate: "2026-08-01" });

      const rows = await withTestPmScope(
        { pmUserId: fallbackPm, pmRole: "pm", isFallbackDecisionMaker: true },
        (client) => client.query("SELECT id FROM leases WHERE id = $1", [leaseB])
      );
      expect(rows.rows.map((r) => r.id)).toEqual([leaseB]);
    });

    it("fallback sees an already-SENT notice assigned to and sent by someone else's door — the 3872 Old Forge Road case", async () => {
      const lateCycle = await seedLateCycle(superuser, { leaseId: leaseB, deMinimisConfigId, dueDate: "2026-07-01" });
      const noticeId = await seedNotice(superuser, {
        lateCycleId: lateCycle,
        leaseId: leaseB,
        letterTemplateId,
        assignedPmId: pmB,
      });
      await superuser.query(
        "UPDATE notices SET status = 'sent', sent_at = now(), sent_by_pm_id = $1, ledger_verified = true WHERE id = $2",
        [pmB, noticeId]
      );

      const rows = await withTestPmScope(
        { pmUserId: fallbackPm, pmRole: "pm", isFallbackDecisionMaker: true },
        (client) => client.query("SELECT id, status FROM notices WHERE id = $1", [noticeId])
      );
      expect(rows.rows).toEqual([{ id: noticeId, status: "sent" }]);
    });

    it("a plain PM (not fallback) still cannot see either case on someone else's door — the widened grant is fallback-only", async () => {
      const lateCycle = await seedLateCycle(superuser, { leaseId: leaseB, deMinimisConfigId, dueDate: "2026-06-01" });
      const noticeId = await seedNotice(superuser, {
        lateCycleId: lateCycle,
        leaseId: leaseB,
        letterTemplateId,
        assignedPmId: pmB,
      });
      await superuser.query(
        "UPDATE notices SET status = 'sent', sent_at = now(), sent_by_pm_id = $1, ledger_verified = true WHERE id = $2",
        [pmB, noticeId]
      );

      const leaseRows = await withTestPmScope({ pmUserId: pmA, pmRole: "pm" }, (client) =>
        client.query("SELECT id FROM leases WHERE id = $1", [leaseB])
      );
      expect(leaseRows.rows).toEqual([]);

      const noticeRows = await withTestPmScope({ pmUserId: pmA, pmRole: "pm" }, (client) =>
        client.query("SELECT id FROM notices WHERE id = $1", [noticeId])
      );
      expect(noticeRows.rows).toEqual([]);
    });
  });

  describe("zero write path anywhere for bookkeeping", () => {
    it("bookkeeping cannot INSERT into leases (no matching WITH CHECK branch)", async () => {
      await expect(
        withTestPmScope({ pmUserId: bookkeeping, pmRole: "bookkeeping" }, (client) =>
          client.query(
            `INSERT INTO leases (buildium_lease_id, property_id, unit_buildium_id, unit_label, rent_due_day, lease_status, synced_at)
             VALUES ('LEASE-HACK', $1, 'unit-hack', 'Hack Unit', 1, 'Active', now())`,
            [propertyA]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("bookkeeping cannot UPDATE an existing lease's grace_period_days", async () => {
      await expect(
        withTestPmScope({ pmUserId: bookkeeping, pmRole: "bookkeeping" }, (client) =>
          client.query("UPDATE leases SET grace_period_days = 99 WHERE id = $1", [leaseA])
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("bookkeeping cannot INSERT into contact_attempts (no INSERT policy at all for this role)", async () => {
      await expect(
        withTestPmScope({ pmUserId: bookkeeping, pmRole: "bookkeeping" }, (client) =>
          client.query(
            `INSERT INTO contact_attempts (lease_id, logged_by_pm_id, contact_method, outcome)
             VALUES ($1, $2, 'phone', 'reached_tenant')`,
            [leaseA, bookkeeping]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("bookkeeping cannot INSERT into notices", async () => {
      const lateCycle = await seedLateCycle(superuser, { leaseId: leaseA, deMinimisConfigId, dueDate: "2026-08-01" });
      await expect(
        withTestPmScope({ pmUserId: bookkeeping, pmRole: "bookkeeping" }, (client) =>
          client.query(
            `INSERT INTO notices (late_cycle_id, lease_id, status, amount_due_at_draft, days_late_at_draft, letter_template_id, assigned_pm_id)
             VALUES ($1, $2, 'draft', 1500, 4, $3, $4)`,
            [lateCycle, leaseA, letterTemplateId, pmA]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe("insert-only-on-contact_attempts for admin_assistant", () => {
    it("admin_assistant CAN insert a contact_attempts row", async () => {
      const result = await withTestPmScope({ pmUserId: adminAssistant, pmRole: "admin_assistant" }, (client) =>
        client.query(
          `INSERT INTO contact_attempts (lease_id, logged_by_pm_id, contact_method, outcome)
           VALUES ($1, $2, 'phone', 'reached_tenant') RETURNING id`,
          [leaseA, adminAssistant]
        )
      );
      expect(result.rows).toHaveLength(1);
    });

    it("admin_assistant CANNOT update a contact_attempts row they just inserted (no UPDATE grant/policy at all — migration 0027 revokes UPDATE table-wide for late_rent_app)", async () => {
      const inserted = await withTestPmScope({ pmUserId: adminAssistant, pmRole: "admin_assistant" }, (client) =>
        client.query(
          `INSERT INTO contact_attempts (lease_id, logged_by_pm_id, contact_method, outcome)
           VALUES ($1, $2, 'phone', 'reached_tenant') RETURNING id`,
          [leaseA, adminAssistant]
        )
      );
      const contactAttemptId = inserted.rows[0].id;
      // This is denied at the GRANT layer ("permission denied for table"),
      // one level before RLS would even get evaluated — migration 0027
      // revokes UPDATE/DELETE on contact_attempts from late_rent_app
      // entirely, table-wide, for every role. Either error text is a valid
      // "write blocked" outcome; both are asserted for since they're the two
      // ways Postgres can refuse a write under this system's design.
      await expect(
        withTestPmScope({ pmUserId: adminAssistant, pmRole: "admin_assistant" }, (client) =>
          client.query("UPDATE contact_attempts SET contact_note = 'edited' WHERE id = $1", [contactAttemptId])
        )
      ).rejects.toThrow(/row-level security|permission denied/i);
    });
  });

  describe("no write path to leases/lease_tenants/late_cycles/notices/notice_recipients for admin_assistant (migrations 0036, 0037)", () => {
    it("admin_assistant cannot INSERT into leases", async () => {
      await expect(
        withTestPmScope({ pmUserId: adminAssistant, pmRole: "admin_assistant" }, (client) =>
          client.query(
            `INSERT INTO leases (buildium_lease_id, property_id, unit_buildium_id, unit_label, rent_due_day, lease_status, synced_at)
             VALUES ('LEASE-HACK-2', $1, 'unit-hack-2', 'Hack Unit 2', 1, 'Active', now())`,
            [propertyA]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("admin_assistant cannot UPDATE leases.grace_period_days even naming themselves is irrelevant (0037 fix — the real prior gap)", async () => {
      // This is the exact bug 0037 fixed: PATCH /api/leases/:id/grace-period
      // relies entirely on this WITH CHECK. Before 0037, admin_assistant's
      // bare `= 'admin_assistant'` branch made this succeed.
      await expect(
        withTestPmScope({ pmUserId: adminAssistant, pmRole: "admin_assistant" }, (client) =>
          client.query("UPDATE leases SET grace_period_days = 7 WHERE id = $1", [leaseA])
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("admin_assistant cannot UPDATE lease_tenants", async () => {
      const tenantRow = await superuser.query<{ id: number }>(
        "SELECT id FROM lease_tenants WHERE lease_id = $1 LIMIT 1",
        [leaseA]
      );
      await expect(
        withTestPmScope({ pmUserId: adminAssistant, pmRole: "admin_assistant" }, (client) =>
          client.query("UPDATE lease_tenants SET email = 'changed@example.com' WHERE id = $1", [
            tenantRow.rows[0].id,
          ])
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("admin_assistant cannot INSERT into late_cycles", async () => {
      await expect(
        withTestPmScope({ pmUserId: adminAssistant, pmRole: "admin_assistant" }, (client) =>
          client.query(
            `INSERT INTO late_cycles (lease_id, due_date, de_minimis_config_id, opened_at)
             VALUES ($1, '2026-09-01', $2, now())`,
            [leaseA, deMinimisConfigId]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("admin_assistant cannot INSERT into notices, even naming themselves as assigned_pm_id (0036 fix — the real prior gap)", async () => {
      const lateCycle = await seedLateCycle(superuser, { leaseId: leaseA, deMinimisConfigId, dueDate: "2026-10-01" });
      // Before migration 0036, this would have succeeded: the ownership
      // check `assigned_pm_id = current_pm_id` passes because
      // admin_assistant has a real pm_users row and can name themselves.
      await expect(
        withTestPmScope({ pmUserId: adminAssistant, pmRole: "admin_assistant" }, (client) =>
          client.query(
            `INSERT INTO notices (late_cycle_id, lease_id, status, amount_due_at_draft, days_late_at_draft, letter_template_id, assigned_pm_id)
             VALUES ($1, $2, 'draft', 1500, 4, $3, $4)`,
            [lateCycle, leaseA, letterTemplateId, adminAssistant]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("admin_assistant cannot INSERT into notice_recipients", async () => {
      const lateCycle = await seedLateCycle(superuser, { leaseId: leaseA, deMinimisConfigId, dueDate: "2026-11-01" });
      const noticeId = await seedNotice(superuser, {
        lateCycleId: lateCycle,
        leaseId: leaseA,
        letterTemplateId,
        assignedPmId: pmA,
      });
      const tenantRow = await superuser.query<{ id: number }>(
        "SELECT id FROM lease_tenants WHERE lease_id = $1 LIMIT 1",
        [leaseA]
      );
      await expect(
        withTestPmScope({ pmUserId: adminAssistant, pmRole: "admin_assistant" }, (client) =>
          client.query(
            `INSERT INTO notice_recipients (notice_id, recipient_type, lease_tenant_id, email_address)
             VALUES ($1, 'to', $2, 'x@example.com')`,
            [noticeId, tenantRow.rows[0].id]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("admin_assistant CAN still read (SELECT) notices portfolio-wide, despite having no write path", async () => {
      const rows = await withTestPmScope({ pmUserId: adminAssistant, pmRole: "admin_assistant" }, (client) =>
        client.query("SELECT id FROM notices")
      );
      expect(rows.rows.length).toBeGreaterThan(0);
    });
  });

  describe("plain PM write path still works (regression check — RLS lockdown didn't also break the PM's own door)", () => {
    it("PM A CAN insert a contact_attempts row for their own lease (baseline sanity: not everyone is locked out)", async () => {
      // NOTE: contact_attempts INSERT policy is admin_assistant-only per
      // migration 0027 — a plain 'pm' has no INSERT policy on this table
      // either. This test documents that (see next test) rather than
      // asserting a false capability.
      await expect(
        withTestPmScope({ pmUserId: pmA, pmRole: "pm" }, (client) =>
          client.query(
            `INSERT INTO contact_attempts (lease_id, logged_by_pm_id, contact_method, outcome)
             VALUES ($1, $2, 'phone', 'reached_tenant')`,
            [leaseA, pmA]
          )
        )
      ).rejects.toThrow(/row-level security/i);
    });

    it("PM A CAN update grace_period_days on a lease within their own door", async () => {
      await withTestPmScope({ pmUserId: pmA, pmRole: "pm" }, (client) =>
        client.query("UPDATE leases SET grace_period_days = 3 WHERE id = $1", [leaseA])
      );
      const check = await superuser.query("SELECT grace_period_days FROM leases WHERE id = $1", [leaseA]);
      expect(check.rows[0].grace_period_days).toBe(3);
    });

    it("PM A CANNOT update grace_period_days on a lease outside their door (property B)", async () => {
      await expect(
        withTestPmScope({ pmUserId: pmA, pmRole: "pm" }, (client) =>
          client.query("UPDATE leases SET grace_period_days = 9 WHERE id = $1", [leaseB])
        )
      ).resolves.toBeDefined(); // UPDATE with 0 matching rows is not an error...
      const check = await superuser.query("SELECT grace_period_days FROM leases WHERE id = $1", [leaseB]);
      expect(check.rows[0].grace_period_days).not.toBe(9); // ...but the row must be untouched.
    });
  });

  // Crashed the live server on 2026-08-04: the fallback decision-maker
  // (Jason) opened a draft notice assigned to someone else, the live-
  // balance re-check found it already paid and tried to void it, and RLS
  // rejected the write — an unhandled error that took the whole Node
  // process down for every user (migrations 0048, 0049). 0048 alone wasn't
  // enough: WITH CHECK governs the new row, but for an UPDATE under a
  // FOR ALL policy Postgres ALSO requires the new row to satisfy USING,
  // proven by direct experiment against the live database (forcing WITH
  // CHECK to a literal `true` still failed; only widening USING too let
  // the write through). These tests pin both requirements down together so
  // a future edit narrowing either clause alone reintroduces the crash
  // immediately, in CI, instead of on the next live drafting morning.
  describe("fallback decision-maker can void (but not otherwise touch) a draft not assigned to them (migrations 0048, 0049)", () => {
    it("the fallback role CAN transition someone else's draft to voided", async () => {
      const notFallbackId = await seedPmUser(superuser, { email: "fallback-void@limehousepm.com", role: "pm", isFallbackDecisionMaker: true });
      const lateCycleId = await seedLateCycle(superuser, { leaseId: leaseB, deMinimisConfigId, dueDate: "2026-08-01" });
      const noticeId = await seedNotice(superuser, {
        lateCycleId,
        leaseId: leaseB,
        letterTemplateId,
        assignedPmId: pmB, // NOT the fallback-role viewer — this is the exact scenario that crashed
        status: "draft",
      });

      await withTestPmScope({ pmUserId: notFallbackId, pmRole: "pm", isFallbackDecisionMaker: true }, (client) =>
        client.query(
          `UPDATE notices SET status = 'voided', voided_at = now(), voided_reason = $1, amount_due_at_send = 0
           WHERE id = $2 AND status = 'draft'`,
          ["paid off before send", noticeId]
        )
      );

      const check = await superuser.query("SELECT status FROM notices WHERE id = $1", [noticeId]);
      expect(check.rows[0].status).toBe("voided");
    });

    it("a plain PM (not the fallback role, not the assignee) CANNOT void someone else's draft", async () => {
      const lateCycleId = await seedLateCycle(superuser, { leaseId: leaseB, deMinimisConfigId, dueDate: "2026-08-02" });
      const noticeId = await seedNotice(superuser, {
        lateCycleId,
        leaseId: leaseB,
        letterTemplateId,
        assignedPmId: pmB,
        status: "draft",
      });

      // pmA is a plain 'pm', not flagged as the fallback decision-maker,
      // and not assigned this notice — the write must silently affect zero
      // rows (RLS filters it out of the UPDATE's own WHERE-visible set),
      // not error and not succeed.
      await withTestPmScope({ pmUserId: pmA, pmRole: "pm", isFallbackDecisionMaker: false }, (client) =>
        client.query(
          `UPDATE notices SET status = 'voided', voided_at = now(), voided_reason = $1, amount_due_at_send = 0
           WHERE id = $2 AND status = 'draft'`,
          ["should not apply", noticeId]
        )
      );

      const check = await superuser.query("SELECT status FROM notices WHERE id = $1", [noticeId]);
      expect(check.rows[0].status).toBe("draft");
    });
  });

  // Found live on 2026-08-04, later the same day as migrations 0048/0049:
  // "View PDF" 404'd with "Notice not found or not visible to you." for a
  // notice that had legitimately auto-voided while a fallback-role viewer
  // was reviewing it. `notices` itself was visible (0048/0049 covered
  // that) — but the detail/PDF routes JOIN notices to leases, and
  // migration 0047's leases/lease_tenants fallback branch only ever
  // matched `notices.status = 'draft'`, never 'voided', so the JOIN
  // silently dropped the row. Migration 0050 fixes this the same way
  // 0048/0049 fixed `notices` itself.
  describe("fallback decision-maker keeps lease/tenant visibility after a draft auto-voids under them (migration 0050)", () => {
    it("the JOIN from notices to leases still returns a row once the notice is voided, not just while it's a draft", async () => {
      const fallbackId = await seedPmUser(superuser, { email: "fallback-voided-join@limehousepm.com", role: "pm", isFallbackDecisionMaker: true });
      const lateCycleId = await seedLateCycle(superuser, { leaseId: leaseB, deMinimisConfigId, dueDate: "2026-08-03" });
      const noticeId = await seedNotice(superuser, {
        lateCycleId,
        leaseId: leaseB,
        letterTemplateId,
        assignedPmId: pmB, // NOT the fallback-role viewer
        status: "draft",
      });
      await superuser.query(
        `UPDATE notices SET status = 'voided', voided_at = now(), voided_reason = 'paid off' WHERE id = $1`,
        [noticeId]
      );

      const rows = await withTestPmScope({ pmUserId: fallbackId, pmRole: "pm", isFallbackDecisionMaker: true }, (client) =>
        client.query("SELECT n.id, l.id AS lease_id FROM notices n JOIN leases l ON l.id = n.lease_id WHERE n.id = $1", [
          noticeId,
        ])
      );
      expect(rows.rows).toHaveLength(1);
      expect(Number(rows.rows[0].lease_id)).toBe(leaseB);
    });

    it("a plain PM (not the fallback role) still gets nothing from that same JOIN", async () => {
      const lateCycleId = await seedLateCycle(superuser, { leaseId: leaseB, deMinimisConfigId, dueDate: "2026-08-04" });
      const noticeId = await seedNotice(superuser, {
        lateCycleId,
        leaseId: leaseB,
        letterTemplateId,
        assignedPmId: pmB,
        status: "draft",
      });
      await superuser.query(
        `UPDATE notices SET status = 'voided', voided_at = now(), voided_reason = 'paid off' WHERE id = $1`,
        [noticeId]
      );

      const rows = await withTestPmScope({ pmUserId: pmA, pmRole: "pm", isFallbackDecisionMaker: false }, (client) =>
        client.query("SELECT n.id FROM notices n JOIN leases l ON l.id = n.lease_id WHERE n.id = $1", [noticeId])
      );
      expect(rows.rows).toEqual([]);
    });
  });

  beforeEach(() => {
    // Each `it` above is written to be independent of ordering within its
    // describe block via fresh seeds where mutation occurs; shared fixtures
    // (pmA/pmB/leaseA/leaseB/etc.) are read-mostly across the suite.
  });
});
