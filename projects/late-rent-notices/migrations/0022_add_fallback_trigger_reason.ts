import type { MigrationBuilder } from "node-pg-migrate";

// Neo's review of Asimov finding 2 (sendAsFallback documentation gap): the
// fallback_events table (migration 0012) records WHO and WHEN a fallback
// send happened, and the DB trigger enforces the hard ceiling, but nothing
// records WHY the assigned PM didn't act before the 2-business-day deadline
// lapsed (routine deadline vs. reported PM unavailability vs. something
// else). Purely additive, nullable, defaulted column — safe on existing
// rows and does not change any existing behavior or trigger logic.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("fallback_events", {
    trigger_reason: {
      type: "text",
      notNull: true,
      default: "deadline_lapsed",
    },
  });

  pgm.addConstraint("fallback_events", "ck_fallback_events_trigger_reason", {
    check: "trigger_reason IN ('deadline_lapsed','pm_unavailable_reported','other')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("fallback_events", "ck_fallback_events_trigger_reason");
  pgm.dropColumn("fallback_events", "trigger_reason");
}
