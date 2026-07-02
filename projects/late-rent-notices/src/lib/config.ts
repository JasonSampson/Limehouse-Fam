import type { Pool, PoolClient } from "pg";

// Reads the currently-active versioned config value (Rule 5: criteria must
// be versioned, never hardcoded). Returns both the value and the row id so
// callers can record which config version gated a given decision.
export async function getActiveConfig(
  db: Pool | PoolClient,
  configKey: string
): Promise<{ id: number; value: unknown }> {
  const result = await db.query<{ id: number; value: unknown }>(
    "SELECT id, value FROM config_values WHERE config_key = $1 AND is_active = true",
    [configKey]
  );
  if (result.rows.length === 0) {
    throw new Error(`No active config value found for key "${configKey}" — has it been seeded?`);
  }
  return result.rows[0];
}

export async function getDeMinimisThreshold(
  db: Pool | PoolClient
): Promise<{ id: number; amount: number }> {
  const { id, value } = await getActiveConfig(db, "de_minimis_threshold_usd");
  const amount = typeof value === "string" ? parseFloat(value) : Number(value);
  if (!Number.isFinite(amount)) {
    throw new Error(`de_minimis_threshold_usd config value is not a valid number: ${JSON.stringify(value)}`);
  }
  return { id, amount };
}

// IMPORTANT: grace period is NOT one company-wide number. Jason: leases
// inherited from a prior management company often carry a different
// late-fee policy than Limehouse's own standard. Buildium's API has no
// grace-period field at all (confirmed against the real OpenAPI spec and
// live calls), so the actual per-lease value lives on leases.grace_period_
// days, manually overridable via PATCH /api/leases/:id/grace-period. This
// function provides only the DEFAULT applied when a lease is first synced
// (src/buildium/sync.ts) — never re-applied afterward, so a manual override
// is never clobbered by a later sync.
export async function getDefaultGracePeriodDays(db: Pool | PoolClient): Promise<{ id: number; days: number }> {
  const { id, value } = await getActiveConfig(db, "default_grace_period_days");
  const days = typeof value === "string" ? parseInt(value, 10) : Number(value);
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`default_grace_period_days config value is not a valid non-negative integer: ${JSON.stringify(value)}`);
  }
  return { id, days };
}

// Companion to getDefaultGracePeriodDays, for leases where
// leases.fee_terms_source = 'inherited_lease' (migration 0023) — a lease
// Limehouse took over managing with a sitting tenant whose terms differ
// from Limehouse's own standard. Buildium has no field for this; the human
// classification on fee_terms_source is the only signal (see
// src/buildium/sync.ts for how the two config values are picked between).
export async function getInheritedLeaseGracePeriodDays(db: Pool | PoolClient): Promise<{ id: number; days: number }> {
  const { id, value } = await getActiveConfig(db, "inherited_lease_grace_period_days");
  const days = typeof value === "string" ? parseInt(value, 10) : Number(value);
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`inherited_lease_grace_period_days config value is not a valid non-negative integer: ${JSON.stringify(value)}`);
  }
  return { id, days };
}

// Fixed, same-for-every-notice ESTIMATE (not ledger-derived, unlike the
// rent/late_fee/other itemization in notice_line_items) — Jason's standing
// SOP figure for the "Court Costs:" line shown on every 14-day notice (see
// migration 0040). Editable by seeding a new config version, same
// deactivate-old/activate-new pattern as grace periods (migrations
// 0021/0030/0031) — never edited in place, per config_values' immutability
// trigger.
export async function getEstimatedCourtCosts(db: Pool | PoolClient): Promise<{ id: number; amount: number }> {
  const { id, value } = await getActiveConfig(db, "estimated_court_costs_usd");
  const amount = typeof value === "string" ? parseFloat(value) : Number(value);
  if (!Number.isFinite(amount)) {
    throw new Error(`estimated_court_costs_usd config value is not a valid number: ${JSON.stringify(value)}`);
  }
  return { id, amount };
}

// Companion to getEstimatedCourtCosts — Jason's standing SOP figure for the
// "Attorney's / Filing Fees:" line shown on every 14-day notice (migration
// 0041).
export async function getEstimatedAttorneyFees(db: Pool | PoolClient): Promise<{ id: number; amount: number }> {
  const { id, value } = await getActiveConfig(db, "estimated_attorney_fees_usd");
  const amount = typeof value === "string" ? parseFloat(value) : Number(value);
  if (!Number.isFinite(amount)) {
    throw new Error(`estimated_attorney_fees_usd config value is not a valid number: ${JSON.stringify(value)}`);
  }
  return { id, amount };
}
