import type { MigrationBuilder } from "node-pg-migrate";

// Read access for the new admin_assistant role (Belinda and Vien), scoped to
// ALL properties — portfolio-wide admin support, not door-restricted like a
// Portfolio Manager (Jason's confirmed decision). Follows the same pattern
// migration 0016 established: the app sets a session-local Postgres setting
// (app.pm_role, added to withPmScope.ts alongside the existing
// app.current_pm_id / app.is_fallback_decision_maker settings) and the RLS
// policy's USING clause checks it. This does NOT grant write access to
// leases/notices/notice_recipients/exclusions — read-only there, same as
// before. contact_attempts gets its own SELECT + INSERT policies below.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE contact_attempts ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE contact_attempts FORCE ROW LEVEL SECURITY;`);

  // --- Extend existing pm-scoped SELECT policies with an admin_assistant branch ---

  pgm.dropPolicy("leases", "pm_scoped_leases");
  pgm.createPolicy("leases", "pm_scoped_leases", {
    using: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR property_id IN (
        SELECT property_id FROM pm_property_assignments
        WHERE pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.dropPolicy("lease_tenants", "pm_scoped_lease_tenants");
  pgm.createPolicy("lease_tenants", "pm_scoped_lease_tenants", {
    using: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.dropPolicy("late_cycles", "pm_scoped_late_cycles");
  pgm.createPolicy("late_cycles", "pm_scoped_late_cycles", {
    using: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  // notices / notice_recipients already carry the fallback-decision-maker
  // OR-branch from migration 0019 — preserve it and add the admin_assistant
  // branch alongside it, read-only (SELECT via USING only, no write grant).
  pgm.dropPolicy("notices", "pm_scoped_notices");
  pgm.createPolicy("notices", "pm_scoped_notices", {
    using: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
    `,
  });

  pgm.dropPolicy("notice_recipients", "pm_scoped_notice_recipients");
  pgm.createPolicy("notice_recipients", "pm_scoped_notice_recipients", {
    using: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
      )
    `,
  });

  // --- contact_attempts: SELECT for admin_assistant (portfolio-wide) and any
  // PM whose door the lease belongs to; INSERT for admin_assistant only. No
  // UPDATE/DELETE policy is created for anyone — RLS FORCE with no policy for
  // an operation denies it outright.

  pgm.createPolicy("contact_attempts", "select_contact_attempts", {
    command: "SELECT",
    using: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.createPolicy("contact_attempts", "insert_contact_attempts_admin_assistant", {
    command: "INSERT",
    check: `current_setting('app.pm_role', true) = 'admin_assistant'`,
  });

  pgm.sql(`GRANT SELECT, INSERT ON contact_attempts TO late_rent_app;`);
  pgm.sql(`REVOKE UPDATE, DELETE ON contact_attempts FROM late_rent_app;`);
  pgm.sql(`GRANT SELECT ON contact_attempts TO late_rent_job;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`REVOKE SELECT ON contact_attempts FROM late_rent_job;`);
  pgm.sql(`REVOKE SELECT, INSERT ON contact_attempts FROM late_rent_app;`);

  pgm.dropPolicy("contact_attempts", "insert_contact_attempts_admin_assistant");
  pgm.dropPolicy("contact_attempts", "select_contact_attempts");

  pgm.dropPolicy("notice_recipients", "pm_scoped_notice_recipients");
  pgm.createPolicy("notice_recipients", "pm_scoped_notice_recipients", {
    using: `
      notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
      )
    `,
  });

  pgm.dropPolicy("notices", "pm_scoped_notices");
  pgm.createPolicy("notices", "pm_scoped_notices", {
    using: `
      assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
    `,
  });

  pgm.dropPolicy("late_cycles", "pm_scoped_late_cycles");
  pgm.createPolicy("late_cycles", "pm_scoped_late_cycles", {
    using: `
      lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.dropPolicy("lease_tenants", "pm_scoped_lease_tenants");
  pgm.createPolicy("lease_tenants", "pm_scoped_lease_tenants", {
    using: `
      lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.dropPolicy("leases", "pm_scoped_leases");
  pgm.createPolicy("leases", "pm_scoped_leases", {
    using: `
      property_id IN (
        SELECT property_id FROM pm_property_assignments
        WHERE pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.sql(`ALTER TABLE contact_attempts DISABLE ROW LEVEL SECURITY;`);
}
