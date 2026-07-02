import type { MigrationBuilder } from "node-pg-migrate";

// Same RLS/grant treatment as notice_recipients (0016/0017), including the
// admin_assistant/bookkeeping read-only-write-blocked pattern established by
// 0033/0036: a PM sees line items for notices they're scoped to see; the two
// portfolio-wide-read roles can SELECT but structurally cannot INSERT/UPDATE
// regardless of what notice_id they might try to write against.
const NON_WRITER_ROLES_CHECK = `current_setting('app.pm_role', true) NOT IN ('admin_assistant', 'bookkeeping')`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON notice_line_items TO late_rent_app;`);
  pgm.sql(`REVOKE DELETE ON notice_line_items FROM late_rent_app;`);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON notice_line_items TO late_rent_job;`);
  pgm.sql(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO late_rent_app, late_rent_job;`);
  pgm.sql(`REVOKE TRUNCATE ON notice_line_items FROM late_rent_app, late_rent_job;`);

  pgm.sql(`ALTER TABLE notice_line_items ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE notice_line_items FORCE ROW LEVEL SECURITY;`);

  pgm.createPolicy("notice_line_items", "pm_scoped_notice_line_items", {
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

  // late_rent_job (the daily/escalation cron) has BYPASSRLS from migration
  // 0016, so this policy does not restrict its writes — it governs the
  // late_rent_app (dashboard) role only, same as every other pm_scoped_*
  // policy in this system.
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropPolicy("notice_line_items", "pm_scoped_notice_line_items");
  pgm.sql(`ALTER TABLE notice_line_items DISABLE ROW LEVEL SECURITY;`);
  pgm.sql(`REVOKE ALL ON notice_line_items FROM late_rent_app, late_rent_job;`);
}
