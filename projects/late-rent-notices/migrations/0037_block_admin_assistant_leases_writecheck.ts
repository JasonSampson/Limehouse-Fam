import type { MigrationBuilder } from "node-pg-migrate";

// Judge finding (final review): migration 0033 fixed the notices/
// notice_recipients WITH CHECK gap (narrowing it to drop the
// admin_assistant OR-branch), and migration 0036 hardened that further with
// a structural NOT IN ('admin_assistant', 'bookkeeping') exclusion. But the
// IDENTICAL gap from migration 0029 was never fixed on the three sibling
// tables that got the same over-broad grant: leases, lease_tenants, and
// late_cycles. Migration 0033's own `up()` restates their WITH CHECK as
// `current_setting('app.pm_role', true) = 'admin_assistant' OR ...` — i.e.
// it deliberately left admin_assistant able to satisfy WITH CHECK on these
// three (0033's comment only describes narrowing notices/notice_recipients;
// leases/lease_tenants/late_cycles were left untouched by design at the
// time, but that design is the bug). Confirmed by reading 0033: bookkeeping
// was never added to these three tables' CHECK clauses at all, so
// bookkeeping has no write path here today — this migration's exclusion
// list still names both roles for the same reason 0036 did: structural
// safety regardless of future USING-clause changes, not because bookkeeping
// currently has a path in.
//
// Concretely, src/routes/leaseRoutes.ts's PATCH /api/leases/:id/grace-period
// has no application-level role check and relies entirely on this RLS
// WITH CHECK — so today, an admin_assistant account (naming themselves via
// current_setting('app.current_pm_id') doesn't even matter here, since the
// leases policy has no ownership condition beyond the admin_assistant
// OR-branch) can update grace_period_days on any lease portfolio-wide. That
// directly changes when a late-rent notice is legally allowed to fire.
//
// Fix: same pattern as 0036 — replace the bare `= 'admin_assistant'` branch
// in WITH CHECK with a NOT IN (...) exclusion ANDed across the whole
// condition, on all three tables. USING (read visibility) is untouched;
// admin_assistant and bookkeeping keep portfolio-wide SELECT.
const NON_WRITER_ROLES_CHECK = `current_setting('app.pm_role', true) NOT IN ('admin_assistant', 'bookkeeping')`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterPolicy("leases", "pm_scoped_leases", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR property_id IN (
        SELECT property_id FROM pm_property_assignments
        WHERE pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
    check: `
      ${NON_WRITER_ROLES_CHECK}
      AND property_id IN (
        SELECT property_id FROM pm_property_assignments
        WHERE pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.alterPolicy("lease_tenants", "pm_scoped_lease_tenants", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
    check: `
      ${NON_WRITER_ROLES_CHECK}
      AND lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.alterPolicy("late_cycles", "pm_scoped_late_cycles", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
    check: `
      ${NON_WRITER_ROLES_CHECK}
      AND lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.alterPolicy("late_cycles", "pm_scoped_late_cycles", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
    check: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.alterPolicy("lease_tenants", "pm_scoped_lease_tenants", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
    check: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.alterPolicy("leases", "pm_scoped_leases", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR property_id IN (
        SELECT property_id FROM pm_property_assignments
        WHERE pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
    check: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR property_id IN (
        SELECT property_id FROM pm_property_assignments
        WHERE pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });
}
