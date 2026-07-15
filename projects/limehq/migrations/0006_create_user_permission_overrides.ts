import type { MigrationBuilder } from "node-pg-migrate";

// Per-person permission tweaks layered on top of the user's role template —
// the "Edited" mechanism (Buildium-style). A row with granted = true adds a
// permission the role doesn't have; granted = false removes one it does.
// Absence of a row means "use whatever the role says."
// Both FKs cascade: removing a user or removing a permission from the catalog
// automatically cleans up override rows.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("user_permission_overrides", {
    id: "id",
    user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    // FK to permission_catalog.permission_key (unique, not the PK).
    permission_key: { type: "text", notNull: true },
    // true  = grant beyond role baseline
    // false = deny despite role baseline
    granted: { type: "boolean", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // FK to permission_catalog.permission_key (unique, not the PK).
  pgm.addConstraint("user_permission_overrides", "fk_upo_permission_key", {
    foreignKeys: {
      columns: ["permission_key"],
      references: "permission_catalog (permission_key)",
      onDelete: "CASCADE",
    },
  });

  // One override row per (user, permission) pair.
  pgm.addConstraint("user_permission_overrides", "uq_upo_user_permission", {
    unique: ["user_id", "permission_key"],
  });

  // Index for the common query: "give me all overrides for this user."
  pgm.createIndex("user_permission_overrides", "user_id", {
    name: "idx_upo_user_id",
  });

  pgm.createTrigger(
    "user_permission_overrides",
    "trg_set_updated_at_user_permission_overrides",
    {
      when: "BEFORE",
      operation: "UPDATE",
      function: "set_updated_at",
      level: "ROW",
    }
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("user_permission_overrides");
}
