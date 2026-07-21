import type { MigrationBuilder } from "node-pg-migrate";

const table = { schema: "map", name: "lease_recurring_charges" };
const leases = { schema: "map", name: "leases" };

// Synced from Buildium's /leases/{leaseId}/recurringtransactions. Only rows
// the sync classifies as a real recurring extra charge belong here — the
// rent line itself (RentId set) and one-time fees (Frequency != 'Monthly',
// e.g. "Tenant Lease Renewal Fee") are never fetched into this shape at all;
// that RentId/Frequency/IsExpired filter is a *data-shape* filter (is this
// even a recurring extra charge?), applied by the sync before it ever builds
// a row for this table.
//
// excluded_from_display is a separate, later filter: a *business/display*
// decision (Jason: "Resident Benefits Package" reads as a background admin
// fee, never show it on the map popup) computed by one shared TypeScript
// helper (src/lib/feeClassification.ts) that both this sync and the
// RentEngine sync call identically, tolerant of wording drift ("Resident
// Benefit(s) Package", case-insensitive, etc). We store the row either way
// rather than dropping it at sync time, so a future "all charges including
// excluded ones" report never needs to be re-derived from Buildium/RentEngine
// after the fact — the popup query just adds `WHERE NOT excluded_from_display`.
//
// buildium_recurring_transaction_id is Buildium's own stable Id for the
// recurring line (confirmed real, confirmed stable) — treated as globally
// unique the same way buildium_lease_id is, not scoped per lease.
//
// Sync note for whoever writes src/buildium/sync.ts: Buildium's per-lease
// fetch is authoritative for that lease, so on each successful fetch the
// sync must delete any lease_recurring_charges row for that lease_id whose
// buildium_recurring_transaction_id is no longer in the current filtered
// result (charge removed, expired, or reclassified as one-time/rent) before
// upserting the current set. This is a scoped, per-lease hard delete — not
// the properties table's "never delete, mark inactive" rule — safe because
// it only ever fires after that lease's own fetch has already succeeded (a
// failed fetch is skipped and leaves existing rows untouched, same as the
// existing per-property error handling in sync.ts).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(table, {
    id: "id",
    lease_id: { type: "bigint", notNull: true, references: leases, onDelete: "RESTRICT" },
    buildium_recurring_transaction_id: { type: "text", notNull: true },
    // Raw Buildium Memo, verbatim — human-entered, inconsistent wording
    // across leases for the same real-world charge. Never rewritten/cleaned
    // in storage; only classified (see excluded_from_display).
    label: { type: "text", notNull: true },
    amount: { type: "numeric(10,2)", notNull: true },
    excluded_from_display: { type: "boolean", notNull: true, default: false },
    synced_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(table, "uq_lrc_buildium_recurring_transaction_id", {
    unique: ["buildium_recurring_transaction_id"],
  });

  pgm.createIndex(table, "lease_id", { name: "idx_lrc_lease_id" });
  // Popup query shape: "give me this lease's displayable extra charges" —
  // mirrors leases' idx_leases_unit_id_status precedent.
  pgm.createIndex(table, ["lease_id", "excluded_from_display"], {
    name: "idx_lrc_lease_id_excluded",
  });

  pgm.createTrigger(table, "trg_set_updated_at_lrc", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(table);
}
