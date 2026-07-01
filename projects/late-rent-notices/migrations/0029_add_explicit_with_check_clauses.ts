import type { MigrationBuilder } from "node-pg-migrate";

// Sentinel finding (defense-in-depth, not a live bug): the RLS policies from
// migrations 0016/0019 only specified a USING clause. Postgres already
// applies USING as the WITH CHECK when WITH CHECK is omitted, so writes were
// never actually unguarded — but leaving it implicit means a future policy
// edit could silently narrow USING (e.g. for read visibility) without
// noticing it also narrowed what INSERT/UPDATE is allowed, or vice versa.
// This makes the check explicit and identical to today's USING clause for
// every policy those two migrations created, changing no actual behavior.
//
// (The admin_assistant policies added in migration 0027 already specify
// their own explicit check where relevant, and notices/notice_recipients/
// leases/lease_tenants/late_cycles were re-created there with the combined
// USING clause — this migration adds the matching WITH CHECK on top of that
// current definition, using ALTER POLICY rather than drop/recreate.)
export async function up(pgm: MigrationBuilder): Promise<void> {
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

  pgm.alterPolicy("exclusions", "pm_scoped_exclusions", {
    using: `
      lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
    check: `
      lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
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
}

// Reverting to USING-only (no explicit check) restores the exact prior
// policy definitions from migrations 0016/0019/0027 — Postgres will again
// implicitly apply USING as the write check, same net behavior.
export async function down(pgm: MigrationBuilder): Promise<void> {
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
  });

  pgm.alterPolicy("notices", "pm_scoped_notices", {
    using: `
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
  });

  pgm.alterPolicy("exclusions", "pm_scoped_exclusions", {
    using: `
      lease_id IN (
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
  });

  pgm.alterPolicy("leases", "pm_scoped_leases", {
    using: `
      current_setting('app.pm_role', true) = 'admin_assistant'
      OR property_id IN (
        SELECT property_id FROM pm_property_assignments
        WHERE pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });
}
