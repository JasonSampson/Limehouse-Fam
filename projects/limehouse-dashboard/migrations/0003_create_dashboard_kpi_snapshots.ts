import type { MigrationBuilder } from "node-pg-migrate";

// One row per (kpi_definition, quarter) = the historical record used for
// the Q2-vs-Q3 trend display and for computing bonus payouts.
//
// CRITICAL correctness requirement from Oracle's spec (reverse-engineered
// Bookkeeper formula): a KPI with no data yet for a quarter (e.g. LeadSimple
// is still blocked, or a role didn't exist yet) must be EXCLUDED from
// scoring, not scored as zero. Modeling this as actual_value/score/payout
// being nullable (rather than defaulting to 0) is what makes that
// distinction representable at the schema level — app code can then do
// "WHERE score IS NOT NULL" for averaging instead of accidentally dragging
// a real average down with phantom zeros. has_data is kept as an explicit
// boolean (not just NULL-checking actual_value) so a KPI that genuinely
// scored a true zero (e.g. 0% late fees waived) is never confused with "we
// have no data for this yet" — those are different things and the app must
// be able to tell them apart even if actual_value is 0 in both rows.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("dashboard_kpi_snapshots", {
    id: "id",
    kpi_definition_id: {
      type: "bigint",
      notNull: true,
      references: "dashboard_kpi_definitions",
      onDelete: "RESTRICT",
    },
    // e.g. '2026-Q2', '2026-Q3'. Stored as text (not a date) because a
    // quarter is a label, not a point in time, and this matches how the
    // dashboard's tiles already reference quarters ("Q2 vs Q3").
    period: { type: "text", notNull: true },
    period_start: { type: "date", notNull: true },
    period_end: { type: "date", notNull: true },
    has_data: { type: "boolean", notNull: true, default: false },
    actual_value: { type: "numeric" },
    target_value: { type: "numeric" }, // snapshot of the target AT THE TIME scored, in case kpi_definitions' target later changes
    // score: the role's normalized performance against target for this KPI
    // (Oracle's spec scoring formula, e.g. percent-of-target scaled and
    // capped). NULL when has_data = false.
    score: { type: "numeric" },
    payout_usd: { type: "numeric" }, // NULL when has_data = false; 0 is a valid real payout, distinct from NULL
    source_system: { type: "text", notNull: true }, // denormalized copy of kpi_definitions.source_system at scoring time, for audit/debugging without a join
    computed_at: { type: "timestamptz" },
    notes: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // The "no data yet" invariant, enforced at the DB level rather than just
  // trusted to app code: if has_data is false, the scoring columns MUST be
  // NULL (excluded from scoring); if has_data is true, actual_value and
  // score MUST be present (payout_usd may still be NULL for KPIs that carry
  // no bonus — max_bonus_usd = 0 on the definition).
  pgm.addConstraint("dashboard_kpi_snapshots", "ck_dashboard_kpi_snapshots_no_data_excluded", {
    check: `
      (has_data = false AND actual_value IS NULL AND score IS NULL AND payout_usd IS NULL)
      OR
      (has_data = true AND actual_value IS NOT NULL AND score IS NOT NULL)
    `,
  });

  pgm.addConstraint("dashboard_kpi_snapshots", "ck_dashboard_kpi_snapshots_source_system", {
    check: "source_system IN ('buildium','rent_engine','lead_simple')",
  });

  pgm.addConstraint("dashboard_kpi_snapshots", "uq_dashboard_kpi_snapshots_definition_period", {
    unique: ["kpi_definition_id", "period"],
  });

  pgm.createIndex("dashboard_kpi_snapshots", ["period"], {
    name: "idx_dashboard_kpi_snapshots_period",
  });
  pgm.createIndex("dashboard_kpi_snapshots", ["kpi_definition_id", "period_start"], {
    name: "idx_dashboard_kpi_snapshots_definition_period_start",
  });

  pgm.createTrigger("dashboard_kpi_snapshots", "trg_set_updated_at_dashboard_kpi_snapshots", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("dashboard_kpi_snapshots", "trg_set_updated_at_dashboard_kpi_snapshots");
  pgm.dropTable("dashboard_kpi_snapshots");
}
