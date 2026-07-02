import type { MigrationBuilder } from "node-pg-migrate";

// Jason's exact words: "On the actual form, we have to put the estimated
// amount for court costs and attorneys fees. On the form, we always put
// court costs at $91 and attorneys fees at $600. This needs to be editable
// as fees are subject to change." These are fixed, same-for-every-notice
// ESTIMATES (not ledger-derived amounts, unlike the rent/late_fee/other
// itemization in migration 0038) — they render on the "Court Costs:" /
// "Attorney's / Filing Fees:" / "TOTAL Fees & Costs:" lines of every 14-day
// notice (src/templates/initialLetterTemplate.ts), replacing what was
// previously fixed placeholder text ("N/A — assessed upon referral to
// attorney").
//
// Same versioned config_values pattern as grace periods (migrations
// 0021/0030/0031): old values deactivated (never overwritten/deleted, per
// migration 0007's immutable-except-is_active design), new version
// activated. When Jason's court-cost estimate changes, a new migration adds
// a new version rather than editing this row — see src/lib/config.ts for the
// getter (getEstimatedCourtCosts) that always reads whichever version is
// currently is_active = true.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    INSERT INTO config_values (config_key, version, value, is_active, set_by_pm_id, change_reason)
    SELECT 'estimated_court_costs_usd', 1, '"91.00"'::jsonb, true, id,
           'Fixed estimated court costs shown on every 14-day notice, per Jason''s standing SOP figure. Not ledger-derived — same estimate on every notice until this config is next updated.'
    FROM pm_users WHERE entra_object_id = 'seed-system-placeholder';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM config_values WHERE config_key = 'estimated_court_costs_usd';`);
}
