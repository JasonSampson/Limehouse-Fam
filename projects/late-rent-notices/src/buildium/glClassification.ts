// GL-account classifier: maps a Buildium charge line to one of the three
// notice_line_items buckets ('rent' | 'late_fee' | 'other'), per Neo's design
// in migration 0038/0039.
//
// VERIFIED LIVE against Limehouse's real Buildium account (2026-07-02, read
// only, via /glaccounts and /leases/{id}/charges + /leases/{id}/transactions)
// before writing this file. Two things Neo's migration comment flagged as
// unverified turned out to matter:
//
// 1. GLAccount.SubType is USELESS for this classification. Every single
//    income-type account in Limehouse's real chart of accounts — Rent
//    Income, Late Fee Income, NSF fees, pet fees, convenience fees, Court
//    Costs, all 40+ of them — has SubType "Income". SubType only
//    distinguishes Income/Expense/Asset/Liability/Equity, not what KIND of
//    income. Neo's proposed SubType 'Rent'/'LateFee' values do not exist.
//
// 2. GLAccount.Name is NOT a safe classification key either, because
//    Limehouse's late fee income account is split per-property:
//    "Late Fee Income- Limehouse" (Id 8) and "Late Fee Income - Red Lion"
//    (Id 649357) are two different Name strings for the same underlying
//    concept. Free-text Name pattern-matching would have to enumerate every
//    property-specific variant and would silently miss the next one added.
//
// The field that actually works: GLAccount.DefaultAccountName +
// IsDefaultGLAccount. Buildium tags its own small set of built-in "default"
// accounts with a stable, human-readable canonical name independent of
// whatever display Name the property manager renamed it to locally. Rent
// Income (GL 3) and Late Fee Income (GL 8, and presumably any per-property
// clone of it) both carry DefaultAccountName "Rent Income" / "Late Fee
// Income" with IsDefaultGLAccount true. That is the authoritative signal
// this classifier uses for the two buckets that carry real legal weight.
//
// IMPORTANT — also confirmed live: /leases/{id}/charges does NOT embed
// GLAccount.Name/Type/SubType/DefaultAccountName on its charge lines, only a
// bare numeric GLAccountId. Callers of this classifier must resolve each
// charge line's GLAccountId against /glaccounts first (see
// fetchGlAccountsById in client.ts) — this module classifies already-
// resolved GL account metadata, it does not fetch anything itself.
//
// "Flag, don't guess": Court Costs / Attorney's Fees accounts (e.g.
// "Court Costs- Tenant", GL 976019, confirmed to exist in the real chart of
// accounts) are Income-type and would otherwise silently fall into 'other'
// — but migration 0038 is explicit that Court Costs/Attorney's Fees are OUT
// OF SCOPE for this table (they belong only to the later day-18
// attorney-referral stage, which stays placeholder text). Landing one of
// those dollars in 'other' on a 14-day pay-or-quit notice would be a
// factually wrong legal notice, not a formatting nit — so it must throw, not
// classify.
//
// Any other charge line that isn't cleanly Rent Income, Late Fee Income, or
// a known-safe-to-bucket-as-Miscellaneous income account is classified as
// 'other' — deliberately permissive for the Miscellaneous bucket (that's
// what the bucket is for: pet fees, utility billbacks, RBP, etc. per Neo's
// migration comment: "e.g. two months of unpaid rent, or a returned-check
// fee stacked on a pet violation fee under 'Miscellaneous'"). The narrow,
// must-not-guess cases are the ones enumerated in AMBIGUOUS_GL_NAME_PATTERNS
// below — accounts whose presence on a charge line signals something is
// structurally wrong (a credit/liability posting, not a real charge) or
// legally out of scope for this table.

export type NoticeLineItemBucket = "rent" | "late_fee" | "other";

// Buildium GL account metadata, already resolved from /glaccounts — the
// shape this classifier consumes. See BuildiumGlAccount in client.ts for the
// Zod-validated version fetched from the API; this local type intentionally
// only requires the fields the classifier reads.
export interface GlAccountForClassification {
  id: number;
  name: string;
  type: string;
  subType: string;
  defaultAccountName: string | null;
  isDefaultGLAccount: boolean;
}

export class UnclassifiableChargeError extends Error {
  constructor(
    message: string,
    public readonly glAccount: GlAccountForClassification
  ) {
    super(message);
    this.name = "UnclassifiableChargeError";
  }
}

// Non-Income GL types should never appear as the account on a tenant charge
// line — a charge posting to a Liability/Asset/Equity/Expense account (e.g.
// GL 18 "Prepayments", a Liability account that shows up on ledger activity
// when a prepayment is APPLIED, not charged) signals this line isn't really
// a new charge owed by the tenant. Rather than guess how to bucket something
// structurally unexpected, flag it.
const EXPECTED_CHARGE_GL_TYPE = "Income";

// Income-type accounts that are legally out of scope for notice_line_items
// per migration 0038's comment (Court Costs / Attorney's Fees apply only at
// the day-18 attorney-referral stage) or otherwise must never be silently
// folded into a bucket. Matched case-insensitively against GLAccount.Name,
// since these don't carry a DefaultAccountName/IsDefaultGLAccount tag the
// way Rent/Late Fee Income do — Name is the only signal Buildium gives us
// for these, so the match is intentionally broad ("court cost", "attorney")
// to catch property-specific naming variants the way "Late Fee Income -
// Red Lion" vs "Late Fee Income- Limehouse" vary for late fees.
const OUT_OF_SCOPE_NAME_PATTERNS: RegExp[] = [/court\s*cost/i, /attorney/i, /filing\s*fee/i];

// Classifies a single resolved GL account into a notice_line_items bucket.
// Throws UnclassifiableChargeError (never returns a guess) when the account
// is out of scope for this table or isn't a real Income-type tenant charge.
export function classifyGlAccount(glAccount: GlAccountForClassification): NoticeLineItemBucket {
  if (glAccount.type !== EXPECTED_CHARGE_GL_TYPE) {
    throw new UnclassifiableChargeError(
      `GL account ${glAccount.id} ("${glAccount.name}") has Type "${glAccount.type}", not "Income" — ` +
        `not a recognizable tenant charge. Refusing to guess a bucket for a legal notice.`,
      glAccount
    );
  }

  if (OUT_OF_SCOPE_NAME_PATTERNS.some((pattern) => pattern.test(glAccount.name))) {
    throw new UnclassifiableChargeError(
      `GL account ${glAccount.id} ("${glAccount.name}") looks like Court Costs / Attorney's Fees, ` +
        `which is out of scope for the 14-day notice itemization (day-18 attorney-referral stage only, ` +
        `per migration 0038). Refusing to fold this into 'other' on this notice.`,
      glAccount
    );
  }

  // The one reliable, property-naming-independent signal: Buildium's own
  // canonical tag on its built-in default accounts.
  if (glAccount.isDefaultGLAccount && glAccount.defaultAccountName === "Rent Income") {
    return "rent";
  }
  if (glAccount.isDefaultGLAccount && glAccount.defaultAccountName === "Late Fee Income") {
    return "late_fee";
  }

  // A non-default account (or a default account whose canonical name isn't
  // Rent/Late Fee) that survived the out-of-scope check above is a real
  // Income-type tenant charge that isn't rent or a late fee — pet rent,
  // utility billback, Resident Benefits Package, NSF fees, convenience
  // fees, etc. That is exactly what 'other'/Miscellaneous is for.
  return "other";
}

// Convenience wrapper for classifying a whole charge (which may have
// multiple GL lines — see BuildiumLeaseCharge in client.ts). Each line is
// classified independently; a charge with lines in two different buckets
// (uncommon in practice — verified live that Limehouse's real charges are
// single-line — but not structurally prevented by the API) returns one
// result per line rather than forcing a single bucket for the whole charge.
export function classifyChargeLines(
  lines: { amount: number; glAccount: GlAccountForClassification }[]
): { amount: number; glAccount: GlAccountForClassification; bucket: NoticeLineItemBucket }[] {
  return lines.map((line) => ({
    ...line,
    bucket: classifyGlAccount(line.glAccount),
  }));
}
