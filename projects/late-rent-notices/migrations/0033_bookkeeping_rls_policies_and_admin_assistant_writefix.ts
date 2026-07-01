import type { MigrationBuilder } from "node-pg-migrate";

// Bookkeeping Coordinator: portfolio-wide (not door-restricted), pure
// read-only across leases, lease_tenants, late_cycles, notices,
// notice_recipients, contact_attempts. Per Oracle's spec: "no send/decide
// authority" — this role gets NO insert anywhere, including
// contact_attempts (unlike admin_assistant, which can log contact
// attempts). Achieved by adding a SELECT-only USING branch for
// current_setting('app.pm_role') = 'bookkeeping' on each table's existing
// policy, and deliberately NOT adding a matching WITH CHECK branch — so
// INSERT/UPDATE still fall through to the existing (non-bookkeeping)
// check condition and are denied for this role under FORCE ROW LEVEL
// SECURITY. contact_attempts gets no bookkeeping branch on its INSERT
// policy at all.
//
// Also fixes a real gap found while building this: migration 0027 gave
// admin_assistant only a SELECT branch on notices/notice_recipients (per
// its own comment: "does NOT grant write access ... read-only there"), but
// migration 0029 then set WITH CHECK equal to the same combined USING
// clause on those two policies — which includes the admin_assistant
// branch. That means admin_assistant currently DOES have a write path
// (INSERT/UPDATE) on notices/notice_recipients via RLS, contradicting the
// intended design (Admin Assistants should be insert-only on
// contact_attempts specifically, read-only everywhere else). This
// migration narrows the WITH CHECK on those two policies back to the
// original non-admin_assistant condition, so USING (read) still includes
// admin_assistant but WITH CHECK (write) no longer does — matching what
// migration 0027's own comment already promised.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE leases FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE lease_tenants FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE late_cycles FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE notices FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE notice_recipients FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE contact_attempts FORCE ROW LEVEL SECURITY;`);

  // --- leases: add bookkeeping to USING only, leave WITH CHECK untouched
  // (alterPolicy requires re-specifying using, so restate the current
  // combined admin_assistant/pm-scoped condition and only widen USING).
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

  // notices / notice_recipients: add bookkeeping to USING, AND narrow
  // WITH CHECK to drop admin_assistant from it (the write-access fix
  // described above — migration 0027's comment already said read-only for
  // admin_assistant here, 0029 just didn't carry that through to CHECK).
  pgm.alterPolicy("notices", "pm_scoped_notices", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
    `,
    check: `
      assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
    `,
  });

  pgm.alterPolicy("notice_recipients", "pm_scoped_notice_recipients", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
      )
    `,
    check: `
      notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
      )
    `,
  });

  // --- contact_attempts: bookkeeping gets its OWN SELECT policy, portfolio-
  // wide, with no WITH CHECK / no INSERT policy at all — so under FORCE RLS,
  // bookkeeping cannot insert here (unlike admin_assistant, which has its
  // own separate insert_contact_attempts_admin_assistant policy from 0027).
  pgm.createPolicy("contact_attempts", "select_contact_attempts_bookkeeping", {
    command: "SELECT",
    using: `current_setting('app.pm_role', true) = 'bookkeeping'`,
  });

  // Bookkeeping needs the app's late_rent_app role to be able to SELECT at
  // all (RLS restricts rows, not table-level privilege) — this grant
  // already exists for late_rent_app from migration 0017, so no additional
  // GRANT is required here; RLS alone determines what rows a given session
  // (any role) can see.
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropPolicy("contact_attempts", "select_contact_attempts_bookkeeping");

  pgm.alterPolicy("notice_recipients", "pm_scoped_notice_recipients", {
    using: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
      )
    `,
    check: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
      )
    `,
  });

  pgm.alterPolicy("notices", "pm_scoped_notices", {
    using: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
    `,
    check: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
    `,
  });

  pgm.alterPolicy("late_cycles", "pm_scoped_late_cycles", {
    using: `
      current_setting('app.pm_role', true) = 'admin_assistant'
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
      current_setting('app.pm_role', true) = 'admin_assistant'
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
      current_setting('app.pm_role', true) = 'admin_assistant'
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
