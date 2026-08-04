import type { MigrationBuilder } from "node-pg-migrate";

// Found live on 2026-08-04, later the same day: clicking "View PDF" on a
// notice returned "Notice not found or not visible to you." — a real 404,
// not a crash. Root cause: three drafts had legitimately auto-voided
// (tenants paid down below threshold while their notices sat in review —
// see staleDraftCheck.ts, and migrations 0048/0049 which already widened
// `notices` itself to keep a fallback-voided notice visible to the
// fallback role). But migration 0047's leases/lease_tenants fallback
// branch only ever matched `notices.status = 'draft'` — never 'voided' —
// so the detail/PDF routes' JOIN from notices to leases silently dropped
// the row even though `notices` alone was visible. Proven directly against
// the live database: `SELECT ... FROM notices JOIN leases ...` under the
// fallback role's session returned zero rows for notice 11 (voided),
// though `SELECT ... FROM notices WHERE id = 11` alone returned it fine.
//
// Fix: widen leases'/lease_tenants' fallback branch the same way 0048/0049
// widened notices' — 'draft' OR 'voided'. Same reasoning as 0049: a voided
// notice a PM was actively reviewing moments ago should stay viewable
// immediately after voiding, not vanish out from under them mid-review.
const FALLBACK_LEASES = `
  (current_setting('app.is_fallback_decision_maker', true) = 'true'
   AND id IN (SELECT lease_id FROM notices WHERE status IN ('draft', 'voided')))
`;

const FALLBACK_LEASE_TENANTS = `
  (current_setting('app.is_fallback_decision_maker', true) = 'true'
   AND lease_id IN (SELECT lease_id FROM notices WHERE status IN ('draft', 'voided')))
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
      OR ${FALLBACK_LEASES}
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
      OR ${FALLBACK_LEASE_TENANTS}
    `,
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  const FALLBACK_DRAFT_LEASES = `
    (current_setting('app.is_fallback_decision_maker', true) = 'true'
     AND id IN (SELECT lease_id FROM notices WHERE status = 'draft'))
  `;
  const FALLBACK_DRAFT_LEASE_TENANTS = `
    (current_setting('app.is_fallback_decision_maker', true) = 'true'
     AND lease_id IN (SELECT lease_id FROM notices WHERE status = 'draft'))
  `;

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
  });

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
  });
}
