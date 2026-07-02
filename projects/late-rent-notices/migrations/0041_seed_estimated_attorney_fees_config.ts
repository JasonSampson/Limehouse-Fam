import type { MigrationBuilder } from "node-pg-migrate";

// Companion to migration 0040 (estimated_court_costs_usd) — same rationale,
// same versioned config_values pattern. Jason's standing SOP figure for the
// "Attorney's / Filing Fees:" line on every 14-day notice.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    INSERT INTO config_values (config_key, version, value, is_active, set_by_pm_id, change_reason)
    SELECT 'estimated_attorney_fees_usd', 1, '"600.00"'::jsonb, true, id,
           'Fixed estimated attorney''s/filing fees shown on every 14-day notice, per Jason''s standing SOP figure. Not ledger-derived — same estimate on every notice until this config is next updated.'
    FROM pm_users WHERE entra_object_id = 'seed-system-placeholder';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM config_values WHERE config_key = 'estimated_attorney_fees_usd';`);
}
