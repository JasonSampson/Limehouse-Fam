import type { MigrationBuilder } from "node-pg-migrate";

// Jason discovered that a property with ZERO pm_property_assignments rows
// (a new property, or an onboarding gap) is invisible to every plain-'pm'
// role user, including himself — even though the daily lateness check still
// correctly identifies a genuinely delinquent tenant there and creates a
// late_cycles row for it (just never a notices row, since it refuses to
// draft a legal notice with nobody accountable to review/send it). The only
// surfacing was a Teams alert (dailyLatenessCheck.ts). He wants the
// property to show up directly, with an inline "assign a PM" action.
//
// Read side (Sentinel-reviewed, cleared): add ONE additional USING branch —
// a lease/late_cycle is also visible to ANY signed-in pm_user (any role) if
// its property currently has NO assignment at all. "Nobody owns it yet" is
// a sound basis for this, since there's no one's door-scoping to protect by
// hiding it. WITH CHECK (write access — e.g. grace-period overrides) is
// deliberately NOT widened, and must restate the EXACT current condition
// from migration 0037 (NOT IN ('admin_assistant','bookkeeping') AND
// assignment-scoped) — not migration 0033's now-superseded version, which
// migration 0037 fixed a real write-access gap in.
//
// Write side (the actual Sentinel finding): pm_property_assignments
// currently has NO RLS and a blanket GRANT SELECT, INSERT, UPDATE to
// late_rent_app (migration 0017) — meaning any signed-in session could, in
// principle, reassign or remove an existing assignment and accidentally
// flip an otherwise-scoped property into the "visible to everyone" bucket.
// The new POST /api/pm-property-assignments route
// (src/routes/pmAssignmentRoutes.ts) only ever INSERTs a brand-new row — it
// never updates or deletes one — so tightening the grant to SELECT, INSERT
// only (revoking UPDATE) closes the theoretical direct-SQL path too,
// matching what the app actually needs. (DELETE was never granted here in
// the first place — see migration 0017's blanket appCrudTables REVOKE
// DELETE.)
const NON_WRITER_ROLES_CHECK = `current_setting('app.pm_role', true) NOT IN ('admin_assistant', 'bookkeeping')`;

export async function up(pgm: MigrationBuilder): Promise<void> {
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
      ${NON_WRITER_ROLES_CHECK}
      AND property_id IN (
        SELECT property_id FROM pm_property_assignments
        WHERE pm_user_id = current_setting('app.current_pm_id', true)::BIGINT
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
      OR lease_id IN (
        SELECT l.id FROM leases l
        WHERE l.property_id NOT IN (SELECT property_id FROM pm_property_assignments)
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

  pgm.sql(`REVOKE UPDATE ON pm_property_assignments FROM late_rent_app;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`GRANT UPDATE ON pm_property_assignments TO late_rent_app;`);

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
}
