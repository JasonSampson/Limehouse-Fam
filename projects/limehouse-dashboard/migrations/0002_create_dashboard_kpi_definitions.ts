import type { MigrationBuilder } from "node-pg-migrate";

// The catalog of every KPI that can appear on the Team Performance tab, one
// row per (role, kpi_name). This is the "menu" — kpi_snapshots (0002) holds
// the actual per-quarter numbers scored against these definitions.
//
// source_system tags where the underlying number comes from, per Oracle's
// spec: 'buildium' (works today), 'rent_engine' or 'lead_simple' (both
// currently blocked pending vendor API access — see README). Marketing
// Specialist is seeded as a role with ZERO kpi_definitions rows on purpose:
// Oracle's spec calls for that role to exist and render on the dashboard
// (empty state) without special-casing "role with no KPIs yet" in app code —
// the absence of rows IS the stub.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("dashboard_kpi_definitions", {
    id: "id",
    role: { type: "text", notNull: true },
    kpi_name: { type: "text", notNull: true },
    // 'ceo_view' rows back the CEO View tab tiles (e.g. Assistant Property
    // Manager / Bookkeeping Coordinator labels); 'team_performance' rows
    // back the password-gated Team Performance tab (Portfolio Assistant /
    // Bookkeeper labels). Per Jason's confirmed decision these are the same
    // underlying role scored once — display_group lets one kpi_definitions
    // row be reused under two labels without duplicating the row; see
    // display_label below.
    display_group: { type: "text", notNull: true },
    // The label shown on screen for this display_group (e.g. "Assistant
    // Property Manager" for ceo_view, "Portfolio Assistant" for
    // team_performance, same role). Kept separate from `role` (the stable
    // internal key used for joins/scoring) so relabeling on screen never
    // requires touching historical snapshot data.
    display_label: { type: "text", notNull: true },
    target_value: { type: "numeric", notNull: true },
    target_operator: { type: "text", notNull: true }, // '>=' or '<='
    unit: { type: "text", notNull: true }, // 'percent', 'currency', 'days', 'count'
    // higher_is_better: true for things like Reconciliation Accuracy;
    // false for things like days-to-resolve. Drives both the scoring
    // formula and which direction an arrow/color points in the UI.
    higher_is_better: { type: "boolean", notNull: true },
    source_system: { type: "text", notNull: true }, // 'buildium' | 'rent_engine' | 'lead_simple'
    max_bonus_usd: { type: "numeric", notNull: true, default: 0 },
    sort_order: { type: "integer", notNull: true, default: 0 },
    is_active: { type: "boolean", notNull: true, default: true },
    notes: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_display_group", {
    check: "display_group IN ('ceo_view','team_performance')",
  });
  pgm.addConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_target_operator", {
    check: "target_operator IN ('>=','<=')",
  });
  pgm.addConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_unit", {
    check: "unit IN ('percent','currency','days','count')",
  });
  pgm.addConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_source_system", {
    check: "source_system IN ('buildium','rent_engine','lead_simple')",
  });
  pgm.addConstraint("dashboard_kpi_definitions", "ck_dashboard_kpi_definitions_max_bonus_nonneg", {
    check: "max_bonus_usd >= 0",
  });

  // A given role can't have the same named KPI twice under the same display
  // group (protects against accidental duplicate seeds, not a business rule
  // change from Oracle's spec).
  pgm.addConstraint("dashboard_kpi_definitions", "uq_dashboard_kpi_definitions_role_kpi_group", {
    unique: ["role", "kpi_name", "display_group"],
  });

  pgm.createIndex("dashboard_kpi_definitions", ["display_group", "role"], {
    name: "idx_dashboard_kpi_definitions_group_role",
  });

  pgm.createTrigger("dashboard_kpi_definitions", "trg_set_updated_at_dashboard_kpi_definitions", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });

  // Seed: Marketing Specialist exists as a role with zero KPI rows today,
  // per Oracle's spec (RentEngine access is blocked — nothing to score yet).
  // This INSERT...WHERE-false pattern documents intent without actually
  // inserting a row (there is nothing to insert — the seed IS the absence).
  // Left as a comment rather than a no-op SQL statement so the "why no rows"
  // reasoning is visible directly in the migration that owns this table.
  //
  //   Marketing Specialist: 0 rows seeded on purpose. When RentEngine access
  //   is confirmed, a later migration adds its KPI rows the normal way —
  //   this table never needs a schema change for that, only new data.
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("dashboard_kpi_definitions", "trg_set_updated_at_dashboard_kpi_definitions");
  pgm.dropTable("dashboard_kpi_definitions");
}
