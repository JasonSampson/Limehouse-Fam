import type { MigrationBuilder } from "node-pg-migrate";

// Closes the gap explicitly deferred by migration 0023's comment ("the
// notice_line_items table for itemized amount-owed breakdowns... left for
// Q... [pending] confirming the exact... itemization approach with
// Oracle/Mason first"). Scotty has since confirmed live that Buildium's
// /leases/{id}/transactions and /leases/{id}/charges both return
// charge-type-level detail via GLAccount.Type/SubType/Name on each line —
// this table is where that detail gets stored per-notice.
//
// Design decision (full reasoning in Neo's report for this change): a child
// table, not new columns on notices. Reasons:
//   1. Cardinality is variable — a tenant can have zero, one, or several
//      charge lines feeding each of the three template buckets (e.g. two
//      months of unpaid rent, or a returned-check fee stacked on a pet
//      violation fee under "Miscellaneous"). Fixed columns would collapse
//      that detail and make it impossible to show/audit what actually made
//      up a bucket if a tenant or their attorney disputes the notice.
//   2. Freeze-at-draft, re-verify-at-send needs the SAME shape captured
//      twice, not overwritten once — exactly how notices.amount_due_at_draft
//      and .amount_due_at_send are two separate columns today (never one
//      column overwritten), preserving the audit trail of what changed
//      between draft and send. snapshot_stage is this table's equivalent of
//      that _at_draft/_at_send column-pair pattern, expressed as rows
//      because there can be N lines per stage instead of exactly one value.
//
// bucket values map directly to the three itemized lines in
// initialLetterTemplate.ts that currently render as placeholder text: 'rent'
// -> "Rent for the Month(s)", 'late_fee' -> "Late Charges", 'other' ->
// "Miscellaneous Charges". Court Costs / Attorney's Fees are explicitly OUT
// of scope here — those apply only at the later day-18 attorney-referral
// stage and correctly stay as placeholder text; this table has no bucket
// for them.
//
// IMPORTANT — flagged for whoever wires the classifier (see
// src/buildium/glClassification.ts, not yet built): the bucket a given
// Buildium charge line maps to is a judgment call based on Buildium's
// documented standard chart of accounts (GLAccount.SubType 'Rent' /
// 'LateFee', or GLAccount.Name pattern-matching). Limehouse's actual chart
// of accounts has NOT been verified against this mapping with live sample
// data. Do not treat this table's presence as proof the classification
// logic is correct — verify against a real /leases/{id}/charges response
// before this ships to a real notice.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("notice_line_items", {
    id: "id",
    notice_id: {
      type: "bigint",
      notNull: true,
      references: "notices",
      onDelete: "RESTRICT",
    },
    // 'draft' = captured when the notice was drafted (dailyLatenessCheck.ts).
    // 'send'  = re-verified from live Buildium data immediately before send
    // (sendNotice.ts), mirroring the existing stale-draft balance recheck.
    // Never overwritten — a second full snapshot, so the audit trail shows
    // whether/how the breakdown changed between draft and send, same intent
    // as notices.amount_due_at_draft vs amount_due_at_send.
    snapshot_stage: { type: "text", notNull: true },
    // Which line of the notice template this charge feeds. Court
    // Costs/Attorney's Fees are deliberately not a valid bucket value here —
    // out of scope, stay placeholder text per the existing day-18 design.
    bucket: { type: "text", notNull: true },
    // Buildium's own GLAccount.Id for the charge line, if present on the
    // response — kept for traceability back to Buildium, not used for any
    // local FK/lookup.
    buildium_gl_account_id: { type: "text" },
    // GLAccount.Name/Type/SubType stored verbatim as returned by Buildium,
    // even though only Name and SubType currently drive the classifier —
    // Type is retained so a human reviewing a disputed notice (or Mason,
    // during an audit) can see exactly what Buildium said this charge was,
    // not just which bucket the app decided to put it in.
    gl_account_name: { type: "text", notNull: true },
    gl_account_type: { type: "text" },
    gl_account_subtype: { type: "text" },
    // Buildium's per-line memo/description, if the endpoint returns one —
    // e.g. "Late fee - June" — useful context on the notice's supporting
    // detail even though it's not rendered into the letter body itself.
    description: { type: "text" },
    amount: { type: "numeric(10,2)", notNull: true },
    // The charge's own date from Buildium (when it was assessed), distinct
    // from created_at (when this row was synced into our database).
    charge_date: { type: "date" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("notice_line_items", "ck_notice_line_items_snapshot_stage", {
    check: "snapshot_stage IN ('draft','send')",
  });
  pgm.addConstraint("notice_line_items", "ck_notice_line_items_bucket", {
    check: "bucket IN ('rent','late_fee','other')",
  });
  // A charge line feeding a legal notice should never be zero or negative —
  // a negative amount is a credit/refund, which the classifier must flag
  // for human review rather than write in here as a charge (see
  // glClassification.ts design note in Neo's report). Zero-amount lines are
  // noise, not a real charge to itemize.
  pgm.addConstraint("notice_line_items", "ck_notice_line_items_amount_positive", {
    check: "amount > 0",
  });

  // The query shape both the drafting job and sendNotice.ts will actually
  // run: "give me every line for notice N at stage S."
  pgm.createIndex("notice_line_items", ["notice_id", "snapshot_stage"], {
    name: "idx_notice_line_items_notice_stage",
  });

  pgm.createTrigger("notice_line_items", "trg_set_updated_at_notice_line_items", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("notice_line_items", "trg_set_updated_at_notice_line_items");
  pgm.dropTable("notice_line_items");
}
