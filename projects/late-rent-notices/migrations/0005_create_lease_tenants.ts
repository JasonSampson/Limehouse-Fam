import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("lease_tenants", {
    id: "id",
    lease_id: {
      type: "bigint",
      notNull: true,
      references: "leases",
      onDelete: "RESTRICT",
    },
    buildium_tenant_id: { type: "text", notNull: true },
    source: { type: "text", notNull: true, default: "buildium" },
    full_name: { type: "text", notNull: true },
    email: { type: "text", notNull: true },
    is_primary: { type: "boolean", notNull: true, default: false },
    synced_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("lease_tenants", "uq_lease_tenants_lease_buildium_tenant", {
    unique: ["lease_id", "buildium_tenant_id"],
  });

  pgm.createIndex("lease_tenants", "lease_id", { name: "idx_lease_tenants_lease" });

  pgm.createTrigger("lease_tenants", "trg_set_updated_at_lease_tenants", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("lease_tenants");
}
