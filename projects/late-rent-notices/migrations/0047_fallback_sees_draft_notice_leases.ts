import type { MigrationBuilder } from "node-pg-migrate";

// Found live on 2026-08-04, the first morning real drafts existed on real
// door assignments: Jason (the fallback decision-maker) opened the
// dashboard and saw ZERO of the 11 drafts. The notices policy (migration
// 0019 onward) deliberately lets the fallback decision-maker see every
// draft notice — but the dashboard query JOINs notices to leases and
// properties, and the leases policy had no matching branch, so the join
// silently filtered out every draft on a door assigned to someone else.
// It never surfaced in July's live test because all 13 test properties
// were temporarily assigned to Jason himself back then.
//
// Fix, scoped to the same intent 0019 already established: the fallback
// decision-maker also gets read visibility into leases (and their
// lease_tenants, for recipient names on the review page) — but ONLY for
// leases that currently have a draft notice. Not portfolio-wide browsing:
// a lease with no draft, or whose notice is already sent/voided, stays
// door-scoped exactly as before. WITH CHECK (writes) is untouched — being
// able to review a draft never made a lease writable.
//
// USING/CHECK text restates the live policies verbatim (0043's
// unassigned-property branch on leases included), with the one new branch
// appended.
const FALLBACK_DRAFT_LEASES = `
  (current_setting('app.is_fallback_decision_maker', true) = 'true'
   AND id IN (SELECT lease_id FROM notices WHERE status = 'draft'))
`;

const FALLBACK_DRAFT_LEASE_TENANTS = `
  (current_setting('app.is_fallback_decision_maker', true) = 'true'
   AND lease_id IN (SELECT lease_id FROM notices WHERE status = 'draft'))
`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterPolicy("leases", "pm_scoped_leases", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR property_id IN (
        SELECT property_id FROM pm_property_assignments
        WHERE pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
      OR property_id NOT IN (SELECT property_id FROM pm_property_assignments)
      OR ${FALLBACK_DRAFT_LEASES}
    `,
    check: `
      current_setting('app.pm_role', true) NOT IN ('admin_assistant', 'bookkeeping')
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
      OR ${FALLBACK_DRAFT_LEASE_TENANTS}
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
}

export async function down(pgm: MigrationBuilder): Promise<void> {
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
      current_setting('app.pm_role', true) NOT IN ('admin_assistant', 'bookkeeping')
      AND lease_id IN (
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
      OR property_id NOT IN (SELECT property_id FROM pm_property_assignments)
    `,
    check: `
      current_setting('app.pm_role', true) NOT IN ('admin_assistant', 'bookkeeping')
      AND property_id IN (
        SELECT property_id FROM pm_property_assignments
        WHERE pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });
}
