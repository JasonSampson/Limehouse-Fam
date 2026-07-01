import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("leases", {
    id: "id",
    buildium_lease_id: { type: "text", notNull: true },
    source: { type: "text", notNull: true, default: "buildium" },
    property_id: {
      type: "bigint",
      notNull: true,
      references: "properties",
      onDelete: "RESTRICT",
    },
    unit_buildium_id: { type: "text", notNull: true },
    unit_label: { type: "text", notNull: true },
    rent_due_day: { type: "smallint", notNull: true },
    grace_period_days: { type: "smallint", notNull: true, default: 0 },
    lease_status: { type: "text", notNull: true },
    synced_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("leases", "uq_leases_buildium_lease_id", {
    unique: ["buildium_lease_id"],
  });
  pgm.addConstraint("leases", "ck_leases_rent_due_day", {
    check: "rent_due_day BETWEEN 1 AND 31",
  });

  pgm.createIndex("leases", "property_id", { name: "idx_leases_property" });
  pgm.createIndex("leases", "lease_status", { name: "idx_leases_status" });

  pgm.createTrigger("leases", "trg_set_updated_at_leases", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("leases");
}
