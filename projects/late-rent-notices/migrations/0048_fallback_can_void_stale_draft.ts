import type { MigrationBuilder } from "node-pg-migrate";

// Crashed the live server on 2026-08-04: Jason (fallback decision-maker)
// opened a draft notice assigned to Dana. The page's live-balance re-check
// (staleDraftCheck.ts) found the balance had changed and tried to
// auto-void the draft — `UPDATE notices SET status = 'voided' ... WHERE
// status = 'draft'`. The fallback branch of notices' WITH CHECK only
// admits a row that's STILL status = 'draft' after the write, so the very
// act of voiding a draft (moving it OUT of 'draft') fails RLS. Postgres
// raised "new row violates row-level security policy", which this route
// (an async Express 4 handler with no try/catch or error middleware)
// never caught — an unhandled rejection, which crashed the entire Node
// process for every user, not just this one request. This exact call path
// was unreachable before migration 0047 (2026-08-04, same day): before
// that, RLS on `leases` never let the fallback role's session load a
// draft assigned to someone else in the first place.
//
// Fix, narrowly scoped to the one status transition this write path
// actually performs: the fallback branch's WITH CHECK now also admits
// 'voided' (not just 'draft'). It still can't reach 'sent' or any other
// status through this branch — a real send only succeeds through the
// existing assigned_pm_id/sent_by_pm_id branches, which the send path
// already satisfies by stamping sent_by_pm_id with the sender's own id.
// USING (read visibility) is unchanged — once voided this way, the row
// naturally drops out of the fallback role's visibility again, same as
// any other voided-and-never-sent draft (already hidden dashboard-wide).
const NON_WRITER_ROLES_CHECK = `current_setting('app.pm_role', true) NOT IN ('admin_assistant', 'bookkeeping')`;

const FALLBACK_CHECK_BRANCH = `(status IN ('draft', 'voided') AND current_setting('app.is_fallback_decision_maker', true) = 'true')`;
const FALLBACK_CHECK_BRANCH_OLD = `(status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')`;

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
        OR ${FALLBACK_CHECK_BRANCH}
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
           OR status IN ('draft', 'voided')
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
      ${NON_WRITER_ROLES_CHECK}
      AND notice_id IN (
        SELECT id FROM notices
        WHERE assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
           OR (status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')
      )
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
      ${NON_WRITER_ROLES_CHECK}
      AND (
        assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
        OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
        OR ${FALLBACK_CHECK_BRANCH_OLD}
      )
    `,
  });
}
