import type { MigrationBuilder } from "node-pg-migrate";

// Judge review finding: the original notices/notice_recipients RLS policies
// (migration 0016) only allowed a PM to see notices where they are the
// assigned_pm_id or the sent_by_pm_id. That makes the fallback-decision-
// maker flow unusable as designed — when Jason looks at a draft notice
// that's still unsent (sent_by_pm_id is null, assigned_pm_id is the PM he's
// covering for, never him), RLS returns zero rows and the route fails with
// "not found," even though the notice exists. This adds visibility (SELECT
// only, via the policy's USING clause) for sessions flagged as fallback
// decision-makers, scoped to draft notices only. This does NOT authorize
// sending — the route layer's isReauthFresh + 2-business-day deadline check
// (src/lib/sendAsFallback.ts) and the fallback_events ceiling trigger
// (migration 0012) are the actual gates on the send action.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropPolicy("notices", "pm_scoped_notices");
  pgm.createPolicy("notices", "pm_scoped_notices", {
    using: `
      assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
    `,
  });

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
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropPolicy("notice_recipients", "pm_scoped_notice_recipients");
  pgm.createPolicy("notice_recipients", "pm_scoped_notice_recipients", {
    using: `
      notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      )
    `,
  });

  pgm.dropPolicy("notices", "pm_scoped_notices");
  pgm.createPolicy("notices", "pm_scoped_notices", {
    using: `
      assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
    `,
  });
}
