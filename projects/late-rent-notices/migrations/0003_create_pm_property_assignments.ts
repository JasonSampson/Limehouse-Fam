import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("pm_property_assignments", {
    id: "id",
    pm_user_id: {
      type: "bigint",
      notNull: true,
      references: "pm_users",
      onDelete: "RESTRICT",
    },
    property_id: {
      type: "bigint",
      notNull: true,
      references: "properties",
      onDelete: "RESTRICT",
    },
    source: { type: "text", notNull: true, default: "buildium" },
    buildium_staff_id: { type: "text" },
    synced_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("pm_property_assignments", "uq_pm_property_assignments_pm_property", {
    unique: ["pm_user_id", "property_id"],
  });

  pgm.createIndex("pm_property_assignments", "property_id", {
    name: "idx_pm_property_assignments_property",
  });

  pgm.createTrigger("pm_property_assignments", "trg_set_updated_at_pm_property_assignments", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("pm_property_assignments");
}
