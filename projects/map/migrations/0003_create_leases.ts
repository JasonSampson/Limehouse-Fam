import type { MigrationBuilder } from "node-pg-migrate";

const table = { schema: "map", name: "leases" };
const units = { schema: "map", name: "units" };

// Synced from Buildium's /v1/leases. Deliberately keeps history (never
// overwritten into oblivion) rather than only tracking "the current
// lease" — mirrors late-rent-notices.leases in spirit, extended with the
// actual rent figure Map's popup needs.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(table, {
    id: "id",
    unit_id: { type: "bigint", notNull: true, references: units, onDelete: "RESTRICT" },
    buildium_lease_id: { type: "text", notNull: true },
    lease_status: { type: "text", notNull: true },
    lease_from: { type: "date", notNull: true },
    // Nullable — month-to-month/open-ended leases may have none.
    lease_to: { type: "date" },
    current_rent: { type: "numeric(10,2)" },
    synced_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(table, "uq_leases_buildium_lease_id", {
    unique: ["buildium_lease_id"],
  });

  pgm.addConstraint(table, "ck_leases_status", {
    check: "lease_status IN ('Active','Future','Past')",
  });

  pgm.createIndex(table, "unit_id", { name: "idx_leases_unit_id" });
  // "Current" is a query, not a column — the map's popup query is always
  // "give me this unit's Active (or else Future) lease" (schema.md).
  pgm.createIndex(table, ["unit_id", "lease_status"], { name: "idx_leases_unit_id_status" });

  pgm.createTrigger(table, "trg_set_updated_at_leases", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(table);
}
