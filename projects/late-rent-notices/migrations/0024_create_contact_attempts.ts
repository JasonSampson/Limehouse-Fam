import type { MigrationBuilder } from "node-pg-migrate";

// Logs a PM's (or admin assistant's) manual contact with a tenant about a
// late balance — phone call, email, or text — independent of the automated
// notice pipeline. This is a record-keeping table, not a send pipeline: it
// never itself contacts anyone.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("contact_attempts", {
    id: "id",
    lease_id: {
      type: "bigint",
      notNull: true,
      references: "leases",
      onDelete: "RESTRICT",
    },
    logged_by_pm_id: {
      type: "bigint",
      notNull: true,
      references: "pm_users",
      onDelete: "RESTRICT",
    },
    contact_method: { type: "text", notNull: true },
    contact_note: { type: "text" },
    outcome: { type: "text", notNull: true },
    promised_pay_date: { type: "date" },
    occurred_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("contact_attempts", "ck_contact_attempts_contact_method", {
    check: "contact_method IN ('phone','email','text')",
  });
  pgm.addConstraint("contact_attempts", "ck_contact_attempts_outcome", {
    check: "outcome IN ('reached_tenant','left_voicemail_no_answer','promised_to_pay','disputed_charge')",
  });
  pgm.addConstraint("contact_attempts", "ck_contact_attempts_promised_pay_date_required", {
    check: "outcome != 'promised_to_pay' OR promised_pay_date IS NOT NULL",
  });

  // Hot-path lookup: "what's the contact history for this lease" and the
  // reminder job's "which promised-pay-dates have passed" scan.
  pgm.createIndex("contact_attempts", "lease_id", { name: "idx_contact_attempts_lease" });
  pgm.createIndex("contact_attempts", "promised_pay_date", {
    name: "idx_contact_attempts_promised_pay_date",
    where: "promised_pay_date IS NOT NULL",
  });

  pgm.createTrigger("contact_attempts", "trg_set_updated_at_contact_attempts", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("contact_attempts");
}
