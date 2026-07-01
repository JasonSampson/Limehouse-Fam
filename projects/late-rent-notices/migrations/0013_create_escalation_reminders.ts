import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("escalation_reminders", {
    id: "id",
    notice_id: {
      type: "bigint",
      notNull: true,
      unique: true,
      references: "notices",
      onDelete: "RESTRICT",
    },
    expiry_date: { type: "date", notNull: true },
    balance_at_check: { type: "numeric(10,2)", notNull: true },
    sent_to_pm_id: {
      type: "bigint",
      notNull: true,
      references: "pm_users",
      onDelete: "RESTRICT",
    },
    sent_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createTrigger("escalation_reminders", "trg_set_updated_at_escalation_reminders", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("escalation_reminders");
}
