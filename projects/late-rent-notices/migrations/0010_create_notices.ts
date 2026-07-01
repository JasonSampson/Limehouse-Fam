import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("notices", {
    id: "id",
    // UNIQUE (not just indexed) — this column is the duplicate guard.
    late_cycle_id: {
      type: "bigint",
      notNull: true,
      unique: true,
      references: "late_cycles",
      onDelete: "RESTRICT",
    },
    lease_id: {
      type: "bigint",
      notNull: true,
      references: "leases",
      onDelete: "RESTRICT",
    },
    status: { type: "text", notNull: true, default: "draft" },
    amount_due_at_draft: { type: "numeric(10,2)", notNull: true },
    days_late_at_draft: { type: "smallint", notNull: true },
    amount_due_at_send: { type: "numeric(10,2)" },
    days_late_at_send: { type: "smallint" },
    letter_template_id: {
      type: "bigint",
      notNull: true,
      references: "letter_templates",
      onDelete: "RESTRICT",
    },
    assigned_pm_id: {
      type: "bigint",
      notNull: true,
      references: "pm_users",
      onDelete: "RESTRICT",
    },
    drafted_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    sent_at: { type: "timestamptz" },
    sent_by_pm_id: {
      type: "bigint",
      references: "pm_users",
      onDelete: "RESTRICT",
    },
    sent_as_fallback: { type: "boolean", notNull: true, default: false },
    ledger_verified: { type: "boolean", notNull: true, default: false },
    voided_at: { type: "timestamptz" },
    voided_reason: { type: "text" },
    delivery_status: { type: "text", notNull: true, default: "pending" },
    delivery_channel: { type: "text", notNull: true, default: "email" },
    // Reserved, unused in v1 — kept available if the email-only delivery
    // decision is ever revisited after an attorney consultation (see plan).
    mail_tracking_number: { type: "text" },
    mail_sent_at: { type: "timestamptz" },
    pm_bounce_notified_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("notices", "ck_notices_status", {
    check: "status IN ('draft','sent','voided','bounced')",
  });
  pgm.addConstraint("notices", "ck_notices_delivery_status", {
    check: "delivery_status IN ('pending','sent','bounced')",
  });
  pgm.addConstraint("notices", "ck_notices_voided_reason_required", {
    check: "status != 'voided' OR voided_reason IS NOT NULL",
  });
  pgm.addConstraint("notices", "ck_notices_sent_at_required", {
    check: "status != 'sent' OR sent_at IS NOT NULL",
  });
  pgm.addConstraint("notices", "ck_notices_fallback_requires_sender", {
    check: "sent_as_fallback = false OR sent_by_pm_id IS NOT NULL",
  });

  pgm.createIndex("notices", "lease_id", { name: "idx_notices_lease" });
  pgm.createIndex("notices", ["assigned_pm_id", "status"], {
    name: "idx_notices_assigned_pm_status",
  });
  pgm.createIndex("notices", ["status", "drafted_at"], {
    name: "idx_notices_status_drafted_at",
    where: "status = 'draft'",
  });

  // DB-level belt-and-suspenders: a notice can never transition to 'sent'
  // without the PM (or fallback decision-maker) having completed the
  // mandatory ledger-verification step. The app must not be trusted alone.
  pgm.createFunction(
    "enforce_ledger_verified_before_send",
    [],
    { returns: "trigger", language: "plpgsql", replace: true },
    `
    BEGIN
      IF NEW.status = 'sent' AND NEW.ledger_verified = false THEN
        RAISE EXCEPTION 'Cannot send notice %: ledger_verified must be true before status=sent', NEW.id;
      END IF;
      RETURN NEW;
    END;
    `
  );

  pgm.createTrigger("notices", "trg_enforce_ledger_verified", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "enforce_ledger_verified_before_send",
    level: "ROW",
  });

  pgm.createTrigger("notices", "trg_set_updated_at_notices", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("notices", "trg_set_updated_at_notices");
  pgm.dropTrigger("notices", "trg_enforce_ledger_verified");
  pgm.dropFunction("enforce_ledger_verified_before_send", []);
  pgm.dropTable("notices");
}
