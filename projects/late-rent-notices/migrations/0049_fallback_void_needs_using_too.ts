import type { MigrationBuilder } from "node-pg-migrate";

// Migration 0048 widened notices' WITH CHECK to admit the fallback role
// voiding a draft (status moving from 'draft' to 'voided'), but the crash
// persisted after applying it. Proven by direct experiment against the
// live database: with WITH CHECK forced to a literal `true` (unconditional
// pass), the exact same UPDATE still failed RLS — conclusively showing
// WITH CHECK was never the actual blocker. Only forcing BOTH USING and
// WITH CHECK to `true` let the write through. For an UPDATE under a FOR
// ALL policy, Postgres requires the resulting row to remain valid under
// USING as well as WITH CHECK — not just the old row, as the standard
// "USING gates the old row, WITH CHECK gates the new row" mental model
// suggests. USING's fallback branch still required status = 'draft' with
// nothing admitting 'voided', so the post-update row failed there instead.
//
// Fix: widen USING's fallback branch the same way 0048 widened WITH
// CHECK's. This does trade a small amount of read-scoping precision for
// correctness — a fallback-voided notice now stays visible to the
// fallback role's own SELECT queries too, not just droppable-out-of-sight
// the instant it's voided (previously assumed harmless in 0048's
// reasoning, but that assumption is now moot: without this, the write
// itself cannot happen at all). A voided-and-never-sent notice already
// stays hidden from every dashboard view regardless of RLS (noticeRoutes.ts
// filters `status != 'voided'`), so this has no visible UI effect.
const FALLBACK_BRANCH_WIDER = `(status IN ('draft', 'voided') AND current_setting('app.is_fallback_decision_maker', true) = 'true')`;
const FALLBACK_BRANCH_NARROW = `(status = 'draft' AND current_setting('app.is_fallback_decision_maker', true) = 'true')`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.alterPolicy("notices", "pm_scoped_notices", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR ${FALLBACK_BRANCH_WIDER}
    `,
  });

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
  });

  pgm.alterPolicy("notices", "pm_scoped_notices", {
    using: `
      current_setting('app.pm_role', true) IN ('admin_assistant', 'bookkeeping')
      OR assigned_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR sent_by_pm_id = current_setting('app.current_pm_id', true)::BIGINT
      OR ${FALLBACK_BRANCH_NARROW}
    `,
  });
}
