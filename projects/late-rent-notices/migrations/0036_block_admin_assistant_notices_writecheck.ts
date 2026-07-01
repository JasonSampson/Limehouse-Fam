import type { MigrationBuilder } from "node-pg-migrate";

// TARS finding: migration 0033 narrowed the notices/notice_recipients
// WITH CHECK clause by dropping the `pm_role = 'admin_assistant'` OR-branch,
// but the remaining condition is purely ownership-based
// (assigned_pm_id/sent_by_pm_id = app.current_pm_id). admin_assistant users
// have their own real row in pm_users (migration 0026), so
// app.current_pm_id is always their own id — if an admin_assistant names
// themselves as assigned_pm_id/sent_by_pm_id on an INSERT/UPDATE, the
// ownership check passes and the write goes through. That's a live write
// path, contradicting the intended design: admin_assistant is read-only on
// notices/notice_recipients, full stop, with no exceptions — same as
// bookkeeping (0033's contact_attempts SELECT-only policy, no WITH CHECK
// branch at all for that role).
//
// Fix: add an explicit role-exclusion to WITH CHECK so it's structurally
// impossible for admin_assistant (or bookkeeping) to satisfy, regardless of
// what assigned_pm_id/sent_by_pm_id/status values are on the row. USING
// (read visibility) is untouched — admin_assistant keeps portfolio-wide
// SELECT on both tables.
const NON_WRITER_ROLES_CHECK = `current_setting('app.pm_role', true) NOT IN ('admin_assistant', 'bookkeeping')`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterPolicy("notices", "pm_scoped_notices", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
    `,
    check: `
      ${NON_WRITER_ROLES_CHECK}
      AND (
        assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
        OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
        OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
      )
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
      ${NON_WRITER_ROLES_CHECK}
      AND notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
      )
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
           OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
      )
    `,
    check: `
      assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
    `,
  });

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
}
