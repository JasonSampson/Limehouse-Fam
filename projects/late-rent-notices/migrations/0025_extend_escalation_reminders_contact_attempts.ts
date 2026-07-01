import type { MigrationBuilder } from "node-pg-migrate";

// escalation_reminders (migration 0013) was built only for "14-day notice
// expired, still unpaid" reminders, keyed by a NOT NULL UNIQUE notice_id.
// This extends it to also carry contact-attempt-based reminders (a tenant
// promised to pay by a date, and that date has passed with nothing resolving
// it logged since) — a second, independent source of "someone needs to
// follow up on this," reusing the same table rather than standing up a
// parallel one.
//
// notice_id becomes nullable and loses its own UNIQUE constraint (a plain
// column-level UNIQUE can't coexist with "sometimes NULL, sometimes shared
// with contact_attempt_id"); the same exactly-once guarantee is preserved
// per-column via two partial unique indexes below, so a given notice or a
// given contact attempt can still only ever get one reminder row.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("escalation_reminders", {
    contact_attempt_id: {
      type: "bigint",
      references: "contact_attempts",
      onDelete: "RESTRICT",
    },
  });

  pgm.dropConstraint("escalation_reminders", "escalation_reminders_notice_id_key");
  pgm.alterColumn("escalation_reminders", "notice_id", { notNull: false });

  pgm.addConstraint("escalation_reminders", "ck_escalation_reminders_exactly_one_source", {
    check: `
      (notice_id IS NOT NULL AND contact_attempt_id IS NULL)
      OR (notice_id IS NULL AND contact_attempt_id IS NOT NULL)
    `,
  });

  pgm.createIndex("escalation_reminders", "notice_id", {
    name: "uq_escalation_reminders_notice_id",
    unique: true,
    where: "notice_id IS NOT NULL",
  });
  pgm.createIndex("escalation_reminders", "contact_attempt_id", {
    name: "uq_escalation_reminders_contact_attempt_id",
    unique: true,
    where: "contact_attempt_id IS NOT NULL",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex("escalation_reminders", "contact_attempt_id", {
    name: "uq_escalation_reminders_contact_attempt_id",
  });
  pgm.dropIndex("escalation_reminders", "notice_id", {
    name: "uq_escalation_reminders_notice_id",
  });
  pgm.dropConstraint("escalation_reminders", "ck_escalation_reminders_exactly_one_source");
  pgm.alterColumn("escalation_reminders", "notice_id", { notNull: true });
  pgm.addConstraint("escalation_reminders", "escalation_reminders_notice_id_key", {
    unique: ["notice_id"],
  });
  pgm.dropColumn("escalation_reminders", "contact_attempt_id");
}
