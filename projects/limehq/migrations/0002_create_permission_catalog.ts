import type { MigrationBuilder } from "node-pg-migrate";

// Stores every permission key in the system. Adding a new permission is an
// INSERT here — never an ALTER TABLE. The permission_key column is the
// dot-notation string (e.g. "dashboard.financials.view") and is the FK
// target used by role_template_permissions and user_permission_overrides.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("permission_catalog", {
    id: "id",
    module: { type: "text", notNull: true },
    feature: { type: "text", notNull: true },
    action: { type: "text", notNull: true },
    permission_key: { type: "text", notNull: true },
    label: { type: "text", notNull: true },
    sort_order: { type: "integer", notNull: true, default: 0 },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // permission_key must be unique — it is the FK target for other tables.
  pgm.addConstraint("permission_catalog", "uq_permission_catalog_key", {
    unique: ["permission_key"],
  });

  // No two rows can describe the same (module, feature, action) triple.
  pgm.addConstraint("permission_catalog", "uq_permission_catalog_module_feature_action", {
    unique: ["module", "feature", "action"],
  });

  // Enforce that permission_key is always exactly module + '.' + feature + '.' + action.
  // This prevents drift between the parts columns and the key string.
  pgm.addConstraint("permission_catalog", "ck_permission_catalog_key_format", {
    check: "permission_key = module || '.' || feature || '.' || action",
  });

  pgm.createTrigger("permission_catalog", "trg_set_updated_at_permission_catalog", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("permission_catalog");
}
