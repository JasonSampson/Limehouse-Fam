import type { MigrationBuilder } from "node-pg-migrate";

// Sentinel finding, 2026-08-04 pre-go-live audit: escalation_reminders
// (migration 0013) and fallback_events (migration 0012) were created with
// NO row-level security at all — the only two PM-facing tables missing it,
// with no in-code comment justifying the omission (unlike pm_users/
// properties/pm_property_assignments, which are deliberately unscoped).
// Not currently exploitable — nothing in src/routes/ ever SELECTs from
// either table today (escalation_reminders is job-only; fallback_events
// only ever gets INSERTed, from sendAsFallback.ts) — but one future route
// away from leaking another PM's financial/identity data with no backstop,
// unlike every other table here.
//
// escalation_reminders has no assigned_pm_id of its own — scoped via
// sent_to_pm_id directly, and via notice_id -> notices for the
// admin_assistant/bookkeeping/fallback-visibility rules that already exist
// on notices, so this table's visibility never diverges from the notice
// it's attached to.
//
// fallback_events has both assigned_pm_id and fallback_pm_id — either PM
// involved in a fallback send should be able to see that it happened.
//
// WITH CHECK matches the one real writer of each table: escalationCheck.ts/
// pmReminderCheck.ts write via the job role (bypasses RLS, as intended —
// see late_rent_job's BYPASSRLS grant), so these WITH CHECK clauses only
// ever matter for late_rent_app, which never writes to either table today.
// Scoped the same way as USING rather than left maximally permissive, so a
// future app-role write path doesn't inherit a wide-open check by default.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE escalation_reminders ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE escalation_reminders FORCE ROW LEVEL SECURITY;`);
  pgm.createPolicy("escalation_reminders", "pm_scoped_escalation_reminders", {
    command: "ALL",
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR sent_to_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR (status IN ('draft', 'voided') AND current_setting('app.is_fallback_decision_maker', true) = 'true')
      )
    `,
    check: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR sent_to_pm_id = current_setting('app.current_pm_id', true)::BIGINT
    `,
  });

  pgm.sql(`ALTER TABLE fallback_events ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE fallback_events FORCE ROW LEVEL SECURITY;`);
  pgm.createPolicy("fallback_events", "pm_scoped_fallback_events", {
    command: "ALL",
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR fallback_pm_id = current_setting('app.current_pm_id', true)::BIGINT
    `,
    check: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR fallback_pm_id = current_setting('app.current_pm_id', true)::BIGINT
    `,
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropPolicy("fallback_events", "pm_scoped_fallback_events");
  pgm.sql(`ALTER TABLE fallback_events DISABLE ROW LEVEL SECURITY;`);

  pgm.dropPolicy("escalation_reminders", "pm_scoped_escalation_reminders");
  pgm.sql(`ALTER TABLE escalation_reminders DISABLE ROW LEVEL SECURITY;`);
}
