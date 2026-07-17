import type { MigrationBuilder } from "node-pg-migrate";

// Root cause (confirmed 2026-07-17): fetchProperties() previously pulled
// EVERY property Buildium has ever seen (323 rows — sold properties,
// historical duplicates, every "OLD"-suffixed stale record), not just the
// 197 actually under management today (client.ts's /rentals?status=Active
// fix, already deployed). The `properties` table itself had no way to
// distinguish real/current from stale — every synced row was treated as
// live by every downstream query (daily lateness check, search, lease
// lists, PM assignment). This migration is purely additive: it adds the
// column so that distinction can exist. It does NOT mark any existing row
// inactive — that requires a live re-check against Buildium's IsActive
// field (the actual source of truth, not the "OLD in the name" heuristic),
// which is a separate one-time data-fix step
// (scripts/markStalePropertiesInactive.ts) run and reviewed on its own,
// against a live Buildium call, not baked into this schema migration.
//
// DEFAULT true is deliberate: every property currently in this table was,
// until this migration, treated as active by every query in the codebase.
// Defaulting new/existing rows to true preserves that behavior for the 197
// real active properties with zero downstream impact at migration time —
// nothing gets hidden or filtered differently the moment this migration
// runs. Rows only change behavior once explicitly set to false by the
// data-fix step, and even then, no data is destroyed (Jason: mark
// inactive, never delete).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("properties", {
    is_active: { type: "boolean", notNull: true, default: true },
  });

  pgm.createIndex("properties", "is_active", { name: "idx_properties_is_active" });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex("properties", "is_active", { name: "idx_properties_is_active" });
  pgm.dropColumn("properties", "is_active");
}
