import { getPool } from "./pool.js";
import { scoreRole, type KpiInput, type RoleScoreResult } from "../kpi/scoring.js";

// Data-access layer bridging dashboard_kpi_definitions (0002) and
// dashboard_kpi_snapshots (0003) to src/kpi/scoring.ts's pure scoring
// function. Keeps the DB queries here and the scoring MATH in scoring.ts
// (already unit-tested against the 5 known-good numbers) so this file has
// no business logic of its own to get wrong.
//
// ROLE DISPLAY NAME BUG (found live, 2026-07-03): the previous version of
// this file built each role's display name from whichever KPI DEFINITION
// ROW happened to be iterated first for that role (`def.displayLabel`) —
// but display_label is documented (migration 0002) as a per-role label
// that's supposed to be IDENTICAL across every KPI row for that role/
// display_group, not a per-KPI label. Relying on "whichever row comes
// first" made this fragile to seed-data ordering, and the frontend was
// matching against this field expecting a genuine role name — every role
// tab silently fell back to the empty state even though the API was
// returning fully correct scored data underneath.
//
// Fix: a canonical, code-owned slug -> display name map, independent of
// whatever happens to be in dashboard_kpi_definitions rows. This is the
// single source of truth for "what does this role slug display as" and
// cannot drift based on seed data ordering or content. ROLE_DISPLAY_NAMES
// also lists every role Limehouse has (including Marketing Specialist,
// which the migration seeds with ZERO KPI rows on purpose per Neo's
// comment) — getScoredRoles() below now iterates this list, not just
// "roles that happen to have a KPI definition row," so Marketing
// Specialist actually appears in the API response with an empty state
// instead of being silently absent from the array entirely (a second,
// related gap found while fixing the first one).
// SAME ROLE, DIFFERENT LABEL PER SCREEN (found live 2026-07-03, by Tron,
// while wiring the frontend against this fix): a single flat map cannot
// express what Neo's own migration 0002 comment already documented —
// "'ceo_view' rows back the CEO View tab tiles (e.g. Assistant Property
// Manager / Bookkeeping Coordinator labels); 'team_performance' rows back
// the password-gated Team Performance tab (Portfolio Assistant / Bookkeeper
// labels)... these are the same underlying role scored once." My first
// pass at this fix collapsed that distinction into one name per role slug,
// which made CEO View render a real scored card under the Team-Performance
// label PLUS a separate always-empty phantom card under the CEO-specific
// label the frontend was actually expecting.
//
// Confirmed against real captured vendor data (coordinator cross-check):
// only portfolio_assistant and bookkeeper actually differ between screens.
// portfolio_manager is "Portfolio Manager" / "PM" on BOTH screens (no
// override needed). CEO_VIEW_ROLE_DISPLAY_NAME_OVERRIDES holds ONLY the
// roles that differ — roleDisplayName() falls back to the base
// ROLE_DISPLAY_NAMES entry when no override exists for the requested
// display group, so adding a role here later never requires touching the
// base map.
const ROLE_DISPLAY_NAMES: Record<string, string> = {
  portfolio_manager: "Portfolio Manager",
  portfolio_assistant: "Portfolio Assistant",
  bookkeeper: "Bookkeeper",
  leasing_specialist: "Leasing Specialist",
  marketing_specialist: "Marketing Specialist",
  administrative_assistant: "Administrative Assistant",
};

const CEO_VIEW_ROLE_DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  portfolio_assistant: "Assistant Property Manager",
  bookkeeper: "Bookkeeping Coordinator",
};

// CEO View only ever had PM / APM / BC role-category rollups per the
// original spec (Oracle) — Leasing Specialist, Marketing Specialist, and
// Administrative Assistant do NOT appear on CEO View at all, on the real
// vendor site or here. CEO_VIEW_ROLES is the allowlist getScoredRoles()
// uses to seed roles for displayGroup='ceo_view' instead of
// allKnownRoles() (which is still correct and used as-is for
// 'team_performance', where all 6 roles genuinely appear).
const CEO_VIEW_ROLES: string[] = ["portfolio_manager", "portfolio_assistant", "bookkeeper"];

// Exported so a test can assert on the mapping directly, and so a caller
// building UI elsewhere (e.g. a role picker) doesn't need its own copy.
// displayGroup defaults to 'team_performance' (the base name) since most
// callers outside getScoredRoles() don't have a screen-specific reason to
// ask for the CEO View variant.
export function roleDisplayName(role: string, displayGroup: "ceo_view" | "team_performance" = "team_performance"): string {
  if (displayGroup === "ceo_view" && role in CEO_VIEW_ROLE_DISPLAY_NAME_OVERRIDES) {
    return CEO_VIEW_ROLE_DISPLAY_NAME_OVERRIDES[role];
  }
  return ROLE_DISPLAY_NAMES[role] ?? role; // unknown role slug: fall back to the raw slug rather than throwing
}

// Which role slugs should appear at all for a given display group.
// 'team_performance' genuinely has all 6 roles; 'ceo_view' only has the 3
// role-category rollups (PM/APM/BC) per the original spec.
export function knownRolesForDisplayGroup(displayGroup: "ceo_view" | "team_performance"): string[] {
  return displayGroup === "ceo_view" ? CEO_VIEW_ROLES : Object.keys(ROLE_DISPLAY_NAMES);
}

// Kept for any existing caller that genuinely wants "every role Limehouse
// has" regardless of screen (e.g. an admin-only role picker) — NOT used by
// getScoredRoles() anymore, which now calls knownRolesForDisplayGroup()
// above so CEO View doesn't seed roles it should never show.
export function allKnownRoles(): string[] {
  return Object.keys(ROLE_DISPLAY_NAMES);
}

export interface KpiDefinitionRow {
  id: number;
  role: string;
  kpiName: string;
  displayGroup: "ceo_view" | "team_performance";
  // The per-KPI label this KPI's own row carries (e.g. "Portfolio Occupancy
  // Rate", "Reconciliation Accuracy") — honestly named as what it actually
  // is now, since the old `displayLabel` name invited exactly the "this
  // must be the role's name" misuse that caused the bug above. Not
  // currently consumed by getScoredRoles() (roleDisplayName() above is the
  // real source for a role's display name), kept here in case a future
  // caller genuinely needs "this specific KPI's own label."
  kpiDisplayLabel: string;
  targetValue: number;
  targetOperator: ">=" | "<=";
  unit: string;
  higherIsBetter: boolean;
  sourceSystem: string;
  maxBonusUsd: number;
  sortOrder: number;
}

export async function getKpiDefinitions(displayGroup: "ceo_view" | "team_performance"): Promise<KpiDefinitionRow[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, role, kpi_name, display_group, display_label, target_value, target_operator,
            unit, higher_is_better, source_system, max_bonus_usd, sort_order
     FROM dashboard_kpi_definitions
     WHERE display_group = $1 AND is_active = true
     ORDER BY role, sort_order`,
    [displayGroup]
  );
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    kpiName: r.kpi_name,
    displayGroup: r.display_group,
    kpiDisplayLabel: r.display_label,
    targetValue: Number(r.target_value),
    targetOperator: r.target_operator,
    unit: r.unit,
    higherIsBetter: r.higher_is_better,
    sourceSystem: r.source_system,
    maxBonusUsd: Number(r.max_bonus_usd),
    sortOrder: r.sort_order,
  }));
}

export interface KpiSnapshotRow {
  kpiDefinitionId: number;
  hasData: boolean;
  actualValue: number | null;
}

export async function getKpiSnapshots(period: string, displayGroup: "ceo_view" | "team_performance"): Promise<KpiSnapshotRow[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT s.kpi_definition_id, s.has_data, s.actual_value
     FROM dashboard_kpi_snapshots s
     JOIN dashboard_kpi_definitions d ON d.id = s.kpi_definition_id
     WHERE s.period = $1 AND d.display_group = $2`,
    [period, displayGroup]
  );
  return rows.map((r) => ({
    // kpi_definition_id is a `bigint` column (see migration 0003), so the
    // `pg` driver returns it as a STRING, not a number. getScoredRoles() in
    // this file builds a Map keyed by this value and looks entries up with
    // def.id (a plain number, from the `integer` id column on
    // dashboard_kpi_definitions) — without this Number() coercion, the
    // string/number mismatch means that Map lookup never matches, so every
    // KPI silently reports hasData:false even when real snapshot data
    // exists in the database. Found and fixed 2026-07-03 while verifying
    // the Team Performance / CEO View screens against seeded data — every
    // KPI showed "No data" despite correct rows in dashboard_kpi_snapshots
    // until this fix was applied.
    kpiDefinitionId: Number(r.kpi_definition_id),
    hasData: r.has_data,
    actualValue: r.actual_value === null ? null : Number(r.actual_value),
  }));
}

export interface RoleScoreWithLabel extends RoleScoreResult {
  // The role's genuine human-readable name FOR THIS SPECIFIC SCREEN (e.g.
  // "Portfolio Assistant" under team_performance, "Assistant Property
  // Manager" under ceo_view for the same underlying role) — NOT from any
  // KPI row's own label. This is the field the frontend should match its
  // role tabs against. `role` (inherited from RoleScoreResult) remains the
  // stable machine slug, unchanged and identical across both screens —
  // it was never the broken part, only the display name was.
  roleDisplayName: string;
}

// Joins definitions + snapshots for one period and runs each role through
// the tested scoring engine. HARD-FILTERS the result to
// knownRolesForDisplayGroup(displayGroup) — team_performance genuinely has
// all 6 roles (so Marketing Specialist, seeded with ZERO KPI rows on
// purpose per Neo's migration 0002 comment, still shows up with an empty
// state instead of being silently missing); ceo_view only has the 3
// PM/APM/BC role-category rollups per the original spec, so Leasing
// Specialist / Marketing Specialist / Administrative Assistant must NEVER
// appear there, no matter what's in the database.
//
// BUG FIX (TARS finding, confirmed independently before patching, 2026-07-
// 03): an earlier version of this function used the allowlist only to
// PRE-SEED empty buckets, then let the definitions loop below silently
// create a new bucket for ANY role slug it encountered in the query
// results — allowlisted or not — which flowed straight into the returned
// array. TARS reproduced this live: inserting dashboard_kpi_definitions
// rows with display_group='ceo_view' for leasing_specialist and
// administrative_assistant made /api/ceo-view/roles return 5 roles instead
// of 3, with two fully real-looking phantom cards (dollar totals, score
// bands, everything) for roles that never appear on the real vendor site's
// CEO View. The old code's own comment defended this as intentional
// ("never hides a role that genuinely has real data") — but that directly
// contradicted this same file's documented spec two paragraphs above it,
// which is exactly backwards: getKpiDefinitions(displayGroup) only filters
// by the display_group COLUMN in SQL, not by role, so a stray/mis-tagged
// DB row was never actually prevented from reaching this function in the
// first place. The allowlist has to be enforced as a HARD FILTER on the
// output, not just used for seeding — a bad row in dashboard_kpi_definitions
// must never be able to put a phantom role card in front of Jason.
export async function getScoredRoles(
  period: string,
  displayGroup: "ceo_view" | "team_performance"
): Promise<RoleScoreWithLabel[]> {
  const allowedRoles = new Set(knownRolesForDisplayGroup(displayGroup));

  const definitions = await getKpiDefinitions(displayGroup);
  const snapshots = await getKpiSnapshots(period, displayGroup);
  const snapshotByDefId = new Map(snapshots.map((s) => [s.kpiDefinitionId, s]));

  const byRole = new Map<string, { maxBonusUsd: number; kpis: KpiInput[] }>();
  for (const role of allowedRoles) {
    byRole.set(role, { maxBonusUsd: 0, kpis: [] });
  }

  for (const def of definitions) {
    // Hard filter: a KPI definition row for a role slug OUTSIDE this
    // displayGroup's allowlist (stray/mis-tagged DB row, or a role added to
    // the DB before the allowlist is updated) is skipped entirely — it
    // must never create a new bucket, and must never reach the returned
    // array. This is the fix: the allowlist now governs BOTH what gets
    // pre-seeded AND what's allowed to exist in byRole at all.
    if (!allowedRoles.has(def.role)) continue;

    const bucket = byRole.get(def.role)!; // guaranteed present: allowedRoles was used to pre-seed byRole above
    // max_bonus_usd is defined per KPI row in the schema but represents the
    // ROLE's total bonus pool — every row for a role carries the same
    // value, so taking the max seen is safe and doesn't double-count.
    bucket.maxBonusUsd = Math.max(bucket.maxBonusUsd, def.maxBonusUsd);
    const snapshot = snapshotByDefId.get(def.id);
    bucket.kpis.push({
      kpiName: def.kpiName,
      hasData: snapshot?.hasData ?? false,
      actualValue: snapshot?.actualValue ?? null,
      targetValue: def.targetValue,
      higherIsBetter: def.higherIsBetter,
    });
  }

  return [...byRole.entries()].map(([role, { maxBonusUsd, kpis }]) => ({
    roleDisplayName: roleDisplayName(role, displayGroup),
    ...scoreRole(role, maxBonusUsd, kpis),
  }));
}
