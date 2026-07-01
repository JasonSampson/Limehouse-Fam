import type { MigrationBuilder } from "node-pg-migrate";

// Judge review finding: src/jobs/pmReminderCheck.ts was reading
// pm_bounce_notified_at (an unrelated column, set by sendNotice.ts when an
// EMAIL BOUNCES) as if it tracked whether the PM nudge reminder had already
// been sent for this draft. It never actually checked or set anything
// meaningful, so every run before the 2-business-day deadline re-sent the
// reminder email — a real duplicate-communication bug, not just a style
// nit. This adds the column the logic actually needs.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("notices", {
    pm_reminder_sent_at: { type: "timestamptz" },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("notices", "pm_reminder_sent_at");
}
