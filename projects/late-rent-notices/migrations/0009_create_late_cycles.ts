import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("late_cycles", {
    id: "id",
    lease_id: {
      type: "bigint",
      notNull: true,
      references: "leases",
      onDelete: "RESTRICT",
    },
    due_date: { type: "date", notNull: true },
    // The de minimis threshold version in effect when this cycle was opened
    // (Rule 5 — every decision must reference the criteria version used).
    de_minimis_config_id: {
      type: "bigint",
      notNull: true,
      references: "config_values",
      onDelete: "RESTRICT",
    },
    opened_at: { type: "timestamptz", notNull: true },
    closed_at: { type: "timestamptz" },
    closed_reason: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // The actual duplicate-guard anchor: one late cycle per lease per due date.
  pgm.addConstraint("late_cycles", "uq_late_cycles_lease_due_date", {
    unique: ["lease_id", "due_date"],
  });

  pgm.addConstraint("late_cycles", "ck_late_cycles_closed_reason", {
    check:
      "closed_reason IS NULL OR closed_reason IN ('paid_in_full','paid_below_threshold','manual')",
  });

  pgm.createIndex("late_cycles", "lease_id", {
    name: "idx_late_cycles_lease_open",
    where: "closed_at IS NULL",
  });

  pgm.createTrigger("late_cycles", "trg_set_updated_at_late_cycles", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("late_cycles");
}
