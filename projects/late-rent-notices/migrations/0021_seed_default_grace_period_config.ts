import type { MigrationBuilder } from "node-pg-migrate";

// NOT a company-wide grace period — Jason: leases inherited from a prior
// management company often carry a different late-fee policy than
// Limehouse's own standard, so grace period is tracked per-lease on
// leases.grace_period_days (manually overridable). This config value is
// only the DEFAULT applied the first time a new lease is synced from
// Buildium (src/buildium/sync.ts) — Buildium's API has no grace-period
// field at all (confirmed against the real OpenAPI spec and live testing).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    INSERT INTO config_values (config_key, version, value, is_active, set_by_pm_id, change_reason)
    SELECT 'default_grace_period_days', 1, '5'::jsonb, true, id,
           'Default grace period applied to newly-synced leases only; per-lease override is the real source of truth.'
    FROM pm_users WHERE entra_object_id = 'seed-system-placeholder';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM config_values WHERE config_key = 'default_grace_period_days';`);
}
