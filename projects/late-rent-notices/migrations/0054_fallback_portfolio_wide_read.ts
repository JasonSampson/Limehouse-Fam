import type { MigrationBuilder } from "node-pg-migrate";

// Fourth recurrence of the same bug shape (0047 draft-visibility, 0048/0049
// fallback-void crash, 0050 voided-visibility): the fallback decision-
// maker's READ access into leases/lease_tenants/notices/notice_recipients
// was built up one notice-status at a time, and each new status Jason
// actually needed to see meant another gap. Found this time from two live
// reports on 2026-08-14:
//   1. "Late, No Notice Yet" showed zero rows for Jason even though 3 real
//      ones exist. Those leases (assigned to Dana) have no notices row at
//      all yet — that's the whole point of the queue — so the old
//      `lease_id IN (SELECT lease_id FROM notices WHERE status IN
//      ('draft','voided'))` fallback branch could never match; there's
//      nothing to match against.
//   2. A genuinely SENT notice (3872 Old Forge Road, notice 2, assigned to
//      and sent by Dana) returned "not found" for Jason, because the
//      fallback branch on `notices` itself only ever covered draft/voided,
//      never sent/bounced.
//
// Fix: stop scoping the fallback branch to specific notice statuses at all.
// Give app.is_fallback_decision_maker the same unconditional, portfolio-wide
// READ visibility admin_assistant/bookkeeping already have on these same
// four tables (migrations 0027/0033) — Jason already has this same
// unscoped access on exclusions/late_cycles (migration 0053), so this makes
// the fallback role consistent across every table instead of narrower on
// some than others, and closes off this whole class of bug rather than
// patching the next status one at a time.
//
// WRITE access (WITH CHECK) is completely untouched by this migration —
// every check clause below is restated byte-for-byte from its current live
// definition (leases/lease_tenants from 0043, notices/notice_recipients
// from 0048). Being able to READ a lease/notice as the fallback role has
// never been what authorizes SENDING one — sendAsFallback.ts's fresh-reauth
// check, the 2-business-day deadline, and the fallback_events ceiling
// trigger (migration 0012) remain the only real gates on that action, same
// as every migration in this chain has insisted.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterPolicy("leases", "pm_scoped_leases", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR property_id IN (
        SELECT property_id FROM pm_property_assignments
        WHERE pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
      OR property_id NOT IN (SELECT property_id FROM pm_property_assignments)
      OR current_setting('app.is_fallback_decision_maker', true) = 'true'
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
      OR current_setting('app.is_fallback_decision_maker', true) = 'true'
    `,
  });

  pgm.alterPolicy("notices", "pm_scoped_notices", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR current_setting('app.is_fallback_decision_maker', true) = 'true'
    `,
  });

  pgm.alterPolicy("notice_recipients", "pm_scoped_notice_recipients", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      )
      OR current_setting('app.is_fallback_decision_maker', true) = 'true'
    `,
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.alterPolicy("notice_recipients", "pm_scoped_notice_recipients", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR status IN ('draft', 'voided')
      )
    `,
  });

  pgm.alterPolicy("notices", "pm_scoped_notices", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR (status IN ('draft', 'voided') AND current_setting('app.is_fallback_decision_maker', true) = 'true')
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
      OR (
        current_setting('app.is_fallback_decision_maker', true) = 'true'
        AND lease_id IN (SELECT lease_id FROM notices WHERE status IN ('draft', 'voided'))
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
      OR property_id NOT IN (SELECT property_id FROM pm_property_assignments)
      OR (
        current_setting('app.is_fallback_decision_maker', true) = 'true'
        AND id IN (SELECT lease_id FROM notices WHERE status IN ('draft', 'voided'))
      )
    `,
  });
}
