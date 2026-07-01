import type { MigrationBuilder } from "node-pg-migrate";

// Jason confirmed the actual SOP numbers: standard-lease grace period = 3
// days (14-Day Notice triggers day 4), inherited-lease grace period = 5 days
// (triggers day 6). Migration 0021 seeded 'default_grace_period_days' = 5 —
// but that key is applied to EVERY newly-synced lease regardless of type
// (src/buildium/sync.ts), not just inherited ones. That means every
// standard lease synced since 0021 ran has been defaulted to the
// inherited-lease timeline by mistake. This migration corrects the
// STANDARD default to 3, matching config_values' immutable-except-
// is_active design: the wrong v1 row is deactivated (never edited/deleted,
// per migration 0007's audit trail rule) and a new v2 row with the correct
// value is activated in its place. See 0031 for the new, separate
// inherited-lease config key that sync.ts now also reads.
//
// NOTE: this migration only fixes the config DEFAULT going forward for any
// future lease sync. It does NOT retroactively touch grace_period_days on
// existing lease rows already synced with the wrong value — sync.ts
// deliberately never overwrites grace_period_days on an existing lease
// (to protect manual overrides), so any standard lease already synced with
// grace_period_days = 5 needs a one-time manual/staff correction or a
// separate backfill; that is outside this migration's scope and flagged
// here for Jason/staff to review.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    UPDATE config_values
    SET is_active = false
    WHERE config_key = 'default_grace_period_days' AND is_active = true;
  `);

  pgm.sql(`
    INSERT INTO config_values (config_key, version, value, is_active, set_by_pm_id, change_reason)
    SELECT 'default_grace_period_days', 2, '3'::jsonb, true, id,
           'Correction: 5 was the inherited-lease value, mistakenly applied to every new lease. 3 is the correct standard-lease default per Limehouse SOP (14-Day Notice on day 4). Inherited leases now get their own config key (see migration 0031) and are picked by src/buildium/sync.ts based on lease.fee_terms_source.'
    FROM pm_users WHERE entra_object_id = 'seed-system-placeholder';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM config_values WHERE config_key = 'default_grace_period_days' AND version = 2;`);
  pgm.sql(`
    UPDATE config_values
    SET is_active = true
    WHERE config_key = 'default_grace_period_days' AND version = 1;
  `);
}
