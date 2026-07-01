import type { MigrationBuilder } from "node-pg-migrate";

// New, separate config key for the inherited-lease grace period, distinct
// from 'default_grace_period_days' (standard leases — corrected to 3 in
// migration 0030). Jason confirmed: inherited leases (a lease Limehouse
// took over managing with a sitting tenant on a prior management company's
// terms) get 5 days, so the 14-Day Notice triggers day 6 instead of day 4.
//
// Buildium's API exposes no field identifying an inherited lease (confirmed
// against the real OpenAPI spec + live calls — see src/buildium/client.ts
// and src/buildium/sync.ts). The only signal this system has is
// leases.fee_terms_source (migration 0023), which is set by a human when a
// lease is entered/classified — this migration does not change that; it
// only removes the SEPARATE manual step of also hand-setting
// grace_period_days once fee_terms_source is known. See src/buildium/
// sync.ts for the updated pick-the-right-default logic.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    INSERT INTO config_values (config_key, version, value, is_active, set_by_pm_id, change_reason)
    SELECT 'inherited_lease_grace_period_days', 1, '5'::jsonb, true, id,
           'Grace period applied to leases where fee_terms_source = inherited_lease, per Limehouse SOP (14-Day Notice on day 6 for inherited leases vs. day 4 for standard). Distinct from default_grace_period_days (standard leases).'
    FROM pm_users WHERE entra_object_id = 'seed-system-placeholder';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM config_values WHERE config_key = 'inherited_lease_grace_period_days';`);
}
