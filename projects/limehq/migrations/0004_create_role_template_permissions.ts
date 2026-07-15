import type { MigrationBuilder } from "node-pg-migrate";

// Maps which permissions are granted to each role template.
// Absence of a row means denied. The granted column defaults to true
// and is kept for future support of explicit deny rows if needed.
// Both FKs cascade on delete: removing a role or removing a permission
// from the catalog automatically cleans up the junction rows.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("role_template_permissions", {
    id: "id",
    role_template_id: {
      type: "bigint",
      notNull: true,
      references: "role_templates",
      onDelete: "CASCADE",
    },
    // permission_key references the unique key column on permission_catalog,
    // not its primary key, so this FK is declared as a named constraint below.
    permission_key: { type: "text", notNull: true },
    granted: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // FK to permission_catalog.permission_key (unique, not the PK).
  pgm.addConstraint("role_template_permissions", "fk_rtp_permission_key", {
    foreignKeys: {
      columns: ["permission_key"],
      references: "permission_catalog (permission_key)",
      onDelete: "CASCADE",
    },
  });

  // One row per (role, permission) pair.
  pgm.addConstraint("role_template_permissions", "uq_rtp_role_permission", {
    unique: ["role_template_id", "permission_key"],
  });

  // Index for the common query: "give me all permissions for this role."
  pgm.createIndex("role_template_permissions", "role_template_id", {
    name: "idx_rtp_role_template_id",
  });

  pgm.createTrigger(
    "role_template_permissions",
    "trg_set_updated_at_role_template_permissions",
    {
      when: "BEFORE",
      operation: "UPDATE",
      function: "set_updated_at",
      level: "ROW",
    }
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("role_template_permissions");
}
