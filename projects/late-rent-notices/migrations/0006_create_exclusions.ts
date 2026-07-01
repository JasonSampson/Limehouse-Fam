import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("exclusions", {
    id: "id",
    lease_id: {
      type: "bigint",
      notNull: true,
      references: "leases",
      onDelete: "RESTRICT",
    },
    source: { type: "text", notNull: true, default: "manual" },
    reason: { type: "text", notNull: true },
    reason_category: { type: "text", notNull: true },
    added_by_pm_id: {
      type: "bigint",
      notNull: true,
      references: "pm_users",
      onDelete: "RESTRICT",
    },
    active: { type: "boolean", notNull: true, default: true },
    removed_by_pm_id: {
      type: "bigint",
      references: "pm_users",
      onDelete: "RESTRICT",
    },
    removed_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("exclusions", "ck_exclusions_reason_category", {
    check: "reason_category IN ('payment_plan','dispute','active_eviction','other')",
  });

  // Hot-path lookup for the daily job: "is this lease currently excluded?"
  pgm.createIndex("exclusions", "lease_id", {
    name: "idx_exclusions_lease_active",
    where: "active = true",
  });

  pgm.createTrigger("exclusions", "trg_set_updated_at_exclusions", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("exclusions");
}
