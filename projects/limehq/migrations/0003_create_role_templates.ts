import type { MigrationBuilder } from "node-pg-migrate";

// Named role definitions (Owner, Admin, Property Manager, etc.).
// Only the Owner role carries a system_role_key — it is the one role that
// cannot be edited or deleted. Application code uses system_role_key to
// locate that role by identity, not by name, so renaming it in the UI is safe.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("role_templates", {
    id: "id",
    name: { type: "text", notNull: true },
    description: { type: "text" },
    is_system_default: { type: "boolean", notNull: true, default: false },
    // Only the two protected seed roles carry a system_role_key.
    // All custom roles leave this NULL.
    system_role_key: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("role_templates", "uq_role_templates_name", {
    unique: ["name"],
  });

  // When set, system_role_key must be the one recognised value.
  pgm.addConstraint("role_templates", "ck_role_templates_system_role_key", {
    check: "system_role_key IS NULL OR system_role_key IN ('owner')",
  });

  pgm.createTrigger("role_templates", "trg_set_updated_at_role_templates", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("role_templates");
}
