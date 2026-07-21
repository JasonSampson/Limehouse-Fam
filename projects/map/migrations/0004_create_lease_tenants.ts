import type { MigrationBuilder } from "node-pg-migrate";

const table = { schema: "map", name: "lease_tenants" };
const leases = { schema: "map", name: "leases" };

// PII lives here: name and phone. Staff-only, full stop — never referenced
// by anything in the public branch. Deliberately no email column (Map's
// popup needs phone, "who to call" — see schema.md).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(table, {
    id: "id",
    lease_id: { type: "bigint", notNull: true, references: leases, onDelete: "RESTRICT" },
    buildium_tenant_id: { type: "text", notNull: true },
    full_name: { type: "text", notNull: true },
    phone: { type: "text" },
    is_primary: { type: "boolean", notNull: true, default: false },
    synced_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(table, "uq_lease_tenants_lease_id_buildium_tenant_id", {
    unique: ["lease_id", "buildium_tenant_id"],
  });

  pgm.createIndex(table, "lease_id", { name: "idx_lease_tenants_lease_id" });

  pgm.createTrigger(table, "trg_set_updated_at_lease_tenants", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(table);
}
