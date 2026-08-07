import type { MigrationBuilder } from "node-pg-migrate";

// Built for Jason's 2026-08-07 request: an owner/admin-only way to
// permanently exclude a "rare case" lease from the automatic notice
// queue (e.g. a bounced payment that, for reasons Jason knows about,
// doesn't warrant another notice). The exclusions table and the daily
// job's exclusion check already existed — but neither `exclusions` nor
// `late_cycles` had a fallback-decision-maker branch in their RLS
// policies (unlike leases/lease_tenants/notices, fixed earlier this same
// week in migrations 0047-0051). Without this, Jason could only exclude
// or close a late_cycle on a lease assigned to HIMSELF — useless for the
// stated purpose, since almost every door is assigned to Dana.
//
// Full read/write for the fallback role on both tables, not scoped to any
// particular lease status — this is a general owner capability, not a
// narrow draft-review permission like the notices fix was.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterPolicy("exclusions", "pm_scoped_exclusions", {
    using: `
      lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
      OR current_setting('app.is_fallback_decision_maker', true) = 'true'
    `,
    check: `
      lease_id IN (
        SELECT l.id FROM leases l
        JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
        WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
      OR current_setting('app.is_fallback_decision_maker', true) = 'true'
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
      OR lease_id IN (
        SELECT l.id FROM leases l
        WHERE l.property_id NOT IN (SELECT property_id FROM pm_property_assignments)
      )
      OR current_setting('app.is_fallback_decision_maker', true) = 'true'
    `,
    check: `
      current_setting('app.pm_role', true) NOT IN ('admin_assistant', 'bookkeeping')
      AND (
        lease_id IN (
          SELECT l.id FROM leases l
          JOIN pm_property_assignments ppa ON ppa.property_id = l.property_id
          WHERE ppa.pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
        )
        OR current_setting('app.is_fallback_decision_maker', true) = 'true'
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
      OR lease_id IN (
        SELECT l.id FROM leases l
        WHERE l.property_id NOT IN (SELECT property_id FROM pm_property_assignments)
      )
    `,
    check: `
      current_setting('app.pm_role', true) NOT IN ('admin_assistant', 'bookkeeping')
      AND lease_id IN (
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
}
