import type { MigrationBuilder } from "node-pg-migrate";

// Neo's review of Mason finding 2 (inherited-lease governing terms): today
// leases.grace_period_days is the only per-lease override of Limehouse's
// standard terms — there is no field capturing WHICH fee terms actually
// govern a given lease (Limehouse's standard Section 16 10% late fee vs.
// terms inherited from a prior management company). This migration adds
// only the classification flag and a human-readable notes field.
//
// Deliberately NOT included here (left for Q, per the fuller plan): the
// actual late_fee_type / late_fee_percentage / late_fee_flat_amount
// columns and their check constraints, and the notice_line_items table for
// itemized amount-owed breakdowns. Those require confirming the exact
// default percentage/config key wiring and itemization approach with
// Oracle/Mason first, so they are not included as a "safe blind addition."
// This migration is scoped to the one flag that is unambiguous and
// zero-risk on its own: marking which leases are known to be governed by
// inherited (non-standard) terms, so existing leases can start being
// triaged/tagged before the fuller fee-terms model is built.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("leases", {
    fee_terms_source: {
      type: "text",
      notNull: true,
      default: "limehouse_standard",
    },
    fee_terms_notes: { type: "text" },
  });

  pgm.addConstraint("leases", "ck_leases_fee_terms_source", {
    check: "fee_terms_source IN ('limehouse_standard','inherited_lease')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("leases", "ck_leases_fee_terms_source");
  pgm.dropColumn("leases", "fee_terms_source");
  pgm.dropColumn("leases", "fee_terms_notes");
}
