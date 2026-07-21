import type { MigrationBuilder } from "node-pg-migrate";

const table = { schema: "map", name: "vacant_listing_recurring_charges" };
const vacantUnitAskingRents = { schema: "map", name: "vacant_unit_asking_rents" };

// Synced from RentEngine's GET /units `monthly_fees` array. Hangs off the
// already-synced vacant_unit_asking_rents row (not unit_id directly) so this
// table never re-derives or duplicates the address-matching logic that
// produces that row — mirrors lease_recurring_charges hanging off leases
// rather than units.
//
// RentEngine's monthly_fees entries have no stable per-fee id (no "Id"
// field), so the natural key is (vacant_unit_asking_rent_id, label) — the
// listing and the fee's own name. Confirmed across all 15 real on-market
// listings this array holds exactly one entry, always "Resident Benefits
// Package" or a wording variant.
//
// excluded_from_display is the same flag and the same shared classification
// helper (src/lib/feeClassification.ts) as lease_recurring_charges — see
// that migration's header for the full sync-time-vs-query-time rationale.
// In practice this means today every row synced into this table will have
// excluded_from_display = true (RentEngine has no reliable utilities/solar
// fee here, only unreliable free text we're deliberately not parsing) — the
// table exists so that changes on RentEngine's side, or Jason's future call
// on the display decision, don't require a schema change to show up.
//
// Sync note for whoever writes src/rentengine/sync.ts: like the Buildium
// side, each listing's monthly_fees fetch is authoritative for that
// listing, so on each successful fetch delete any
// vacant_listing_recurring_charges row for that vacant_unit_asking_rent_id
// whose label is no longer present before upserting the current set.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(table, {
    id: "id",
    vacant_unit_asking_rent_id: {
      type: "bigint",
      notNull: true,
      references: vacantUnitAskingRents,
      onDelete: "RESTRICT",
    },
    // Raw RentEngine fee name, verbatim — same "don't rewrite, only
    // classify" rule as lease_recurring_charges.label.
    label: { type: "text", notNull: true },
    amount: { type: "numeric(10,2)", notNull: true },
    excluded_from_display: { type: "boolean", notNull: true, default: false },
    synced_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(table, "uq_vlrc_vacant_unit_asking_rent_id_label", {
    unique: ["vacant_unit_asking_rent_id", "label"],
  });

  pgm.createIndex(table, "vacant_unit_asking_rent_id", { name: "idx_vlrc_vacant_unit_asking_rent_id" });

  pgm.createTrigger(table, "trg_set_updated_at_vlrc", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(table);
}
