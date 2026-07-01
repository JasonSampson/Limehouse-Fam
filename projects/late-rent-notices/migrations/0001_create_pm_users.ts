import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("pm_users", {
    id: "id",
    entra_object_id: { type: "text", notNull: true },
    display_name: { type: "text", notNull: true },
    email: { type: "text", notNull: true },
    is_fallback_decision_maker: { type: "boolean", notNull: true, default: false },
    active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("pm_users", "uq_pm_users_entra_object_id", {
    unique: ["entra_object_id"],
  });

  pgm.createTrigger("pm_users", "trg_set_updated_at_pm_users", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("pm_users");
}
