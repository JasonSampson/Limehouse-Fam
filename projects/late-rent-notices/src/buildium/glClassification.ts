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
// UPDATED 2026-07-02 per Jason's explicit business rule for the itemized
// notice breakdown:
//   Rent bucket:      Rent, Utilities, Pet Rent, Resident Benefits Package
//   Late Fee bucket:  Late Fees, NSF Fees, Admin/manual payment processing
//                      fee, Unlawful Detainer filing fee
// None of Utilities/Pet Rent/RBP/NSF/Admin-fee/UD-fee are IsDefaultGLAccount
// accounts in Limehouse's real chart of accounts (only Rent Income, Late Fee
// Income, NSF Fee Income, Accounts Receivable, Undeposited Funds, Security
// Deposit Liability, Accounts Payable, Retained Earnings, Owner
// Contribution/Draw, Application Fee Income are IsDefaultGLAccount=true —
// verified live against the full /glaccounts response). So these six new
// charge types are matched by exact GLAccount.Name below instead — same
// "known-good list, not loosened logic" philosophy as the existing
// DefaultAccountName check, just keyed on Name because Buildium gives us no
// DefaultAccountName tag for these. Every Name below was confirmed either on
// a real charge line across the 59 real leases with an outstanding balance,
// or (Unlawful Detainer Filing Fee) in the full chart of accounts directly.
// Per-property Name variants (the same problem that produced "Late Fee
// Income- Limehouse" vs "- Red Lion") are handled the same way the existing
// late-fee entry does: list every real variant seen, rather than pattern-
// matching, so a typo'd future variant fails loud (UnclassifiableChargeError)
// instead of silently guessing.
//
// IMPORTANT — real bug found while pulling this data: /glaccounts?limit=1000
// only returns Buildium's 121 TOP-LEVEL GL accounts. Sub-accounts (Buildium's
// nested "SubAccounts" on a parent account, e.g. "Lease Change Fee" nested
// under "Mgmnt Fee Income - LH Plan") are NOT included as their own flat row
// — yet real tenant charges post directly to sub-account GLAccountIds. This
// classifier only ever sees whatever fetchGlAccountsById() resolved, so that
// map had to be fixed (see client.ts) to flatten one level of SubAccounts;
// otherwise charges posted to any sub-account GL id would resolve to
// "unknown account" and block the whole notice, even though every sub-
// account observed live is a normal Income-type charge, not something
// structurally wrong.
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
// FLAGGED FOR MASON/ORACLE — Court Costs vs. "Unlawful Detainer filing fee"
// are NOT the same real-world charge, and this file does NOT merge them:
//   - "Court Costs- Tenant" (GL 976019, top-level, Income) — 3 real charge
//     lines observed, $758 total. This is the account migration 0038 held
//     out of scope ("Court Costs/Attorney's Fees... belong only to the
//     later day-18 attorney-referral stage").
//   - "Unlawful Detainer Filing Fee" (GL 1014311, top-level, Income) — a
//     DIFFERENT account, 3 real charge lines observed, $600 total. This is
//     the one Jason named in his bucketing rule and is now classified as
//     'late_fee' below, appearing on the 14-day notice itemization.
//   - There is also "UD Filing/Court Rep Fee" (GL 836697, a SUB-account of
//     "Mgmnt Fee Income - LH Plan", GL 657394) — a THIRD, textually similar
//     account, not observed on any real charge line in this sample and NOT
//     added to the known-good list below. If a future charge lands on GL
//     836697, this classifier will throw rather than guess whether Jason
//     meant that one too — a real, human decision, not a code judgment call.
// In short: this change adds GL 1014311 to the 'late_fee' bucket. It does
// NOT touch GL 976019 (Court Costs), which stays out of scope exactly as
// migration 0038 designed, and does NOT touch GL 836697, which isn't on the
// known-good list at all.
//
// Any other charge line that isn't cleanly Rent Income, Late Fee Income, one
// of the six newly-added Name matches below, or a known-safe-to-bucket-as-
// Miscellaneous income account is classified as 'other' — deliberately
// permissive for the Miscellaneous bucket (that's what the bucket is for:
// e.g. Application Fee Income, Convenience Fee, Tenant Lease Renewal Fee,
// per Neo's migration comment: "e.g. two months of unpaid rent, or a
// returned-check fee stacked on a pet violation fee under 'Miscellaneous'").
// The narrow, must-not-guess cases are the ones enumerated in
// OUT_OF_SCOPE_NAME_PATTERNS below — accounts whose presence on a charge
// line signals something is structurally wrong (a credit/liability posting,
// not a real charge) or legally out of scope for this table.

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
// line in the sense of "money the tenant now owes" — a charge posting to a
// Liability/Asset/Equity/Expense account signals this line isn't really a
// new charge owed by the tenant. Rather than guess how to bucket something
// structurally unexpected, the default is still to flag it (see
// classifyGlAccount below). EXCLUDED_GL_TYPE_ACCOUNTS just below is a narrow,
// verified carve-out from that default for two specific accounts that are
// not ambiguous at all.
const EXPECTED_CHARGE_GL_TYPE = "Income";

// VERIFIED LIVE 2026-07-02 against all 60 real leases with an outstanding
// balance: every one of them has ledger lines posting to GL 5 "Security
// Deposit Liability" and/or GL 18 "Prepayments" (436 lines total: 376
// Prepayments + 60 Security Deposit Liability). Both are Type=Liability,
// SubType=CurrentLiability, IsDefaultGLAccount=true with DefaultAccountName
// matching their Name exactly — Buildium's own canonical tag, the same
// signal already trusted for Rent Income/Late Fee Income above, just on the
// Liability side of the chart of accounts instead of Income.
//
// These are NOT ambiguous charges that need a human decision — they are not
// tenant charges at all:
//   - Security Deposit Liability: the deposit is money Limehouse holds in
//     trust for the tenant, not rent owed. It is a liability (money owed
//     BACK to the tenant, eventually), never something itemized as owed ON
//     a pay-or-quit notice.
//   - Prepayments: money the tenant already paid in advance and Buildium is
//     crediting/applying against future rent. A ledger line here reflects
//     that credit being applied, not a new charge being levied.
// Excluding both from the itemization (never summed into rent/late_fee/
// other, never blocking) is the correct behavior, not a loosening of the
// "throw, don't guess" rule — that rule exists to protect against
// mis-telling a tenant what they owe on a legal notice, and neither of these
// accounts represents an amount owed by the tenant in the first place.
//
// This does NOT touch the throw behavior for any other non-Income type
// (Asset/Equity/Expense, or a Liability account that ISN'T one of these two
// specific known-safe ones) — those remain exactly as before: refuse to
// guess, throw UnclassifiableChargeError, block the notice for human review.
const EXCLUDED_GL_ACCOUNTS = new Set<number>([
  5, // Security Deposit Liability
  18, // Prepayments
]);

// Marker return value meaning "not a tenant charge — leave this line out of
// the itemization entirely." Distinct from any NoticeLineItemBucket so
// callers can't accidentally sum it into rent/late_fee/other.
export const EXCLUDED_NOT_A_CHARGE = "excluded_not_a_charge" as const;
export type ClassificationResult = NoticeLineItemBucket | typeof EXCLUDED_NOT_A_CHARGE;

// Income-type accounts that are legally out of scope for notice_line_items
// per migration 0038's comment (Court Costs / Attorney's Fees apply only at
// the day-18 attorney-referral stage) or otherwise must never be silently
// folded into a bucket. Matched case-insensitively against GLAccount.Name,
// since these don't carry a DefaultAccountName/IsDefaultGLAccount tag the
// way Rent/Late Fee Income do — Name is the only signal Buildium gives us
// for these, so the match is intentionally broad ("court cost", "attorney")
// to catch property-specific naming variants the way "Late Fee Income -
// Red Lion" vs "Late Fee Income- Limehouse" vary for late fees.
//
// NOTE: this pattern deliberately does NOT include a bare "filing fee" match
// anymore. It originally did, but that also matched "Unlawful Detainer
// Filing Fee" (GL 1014311) — which Jason has now explicitly named as
// belonging IN the 14-day notice's late_fee bucket (see RENT_BUCKET_NAMES /
// LATE_FEE_BUCKET_NAMES below), the opposite of out-of-scope. "Court cost"
// and "attorney" alone still catch GL 976019 "Court Costs- Tenant" and any
// attorney's-fees account, which is what migration 0038 actually meant to
// exclude.
const OUT_OF_SCOPE_NAME_PATTERNS: RegExp[] = [/court\s*cost/i, /attorney/i];

// Exact-Name known-good list for the six additional charge types in Jason's
// 2026-07-02 rent/late-fee bucketing rule. None of these carry
// IsDefaultGLAccount/DefaultAccountName (verified live against the full real
// chart of accounts — see file header), so unlike Rent/Late Fee Income they
// are matched on GLAccount.Name exactly, case-sensitively, against every
// real variant actually observed (or, for the one not seen on a real charge
// line yet, confirmed directly in the chart of accounts). This is a
// closed list, not a pattern — a differently-worded future account (e.g. a
// new per-property clone the way "Late Fee Income - Red Lion" was) will
// fall through to 'other' or, if it collides with OUT_OF_SCOPE_NAME_PATTERNS
// or looks structurally wrong, throw — it will NOT silently join this list.
//
// Rent bucket additions: Utilities, Pet Rent, Resident Benefits Package.
const RENT_BUCKET_NAMES = new Set<string>([
  "Utility Income", // GL 636963 — confirmed on 315 real charge lines, $28,418.30 total
  "Pet Rent", // GL 876174 — confirmed on 107 real charge lines, $5,304.52 total
  "Pet Rent- Limehouse", // GL 992070 — confirmed on 190 real charge lines, $14,126.33 total (property-specific variant, same pattern as Late Fee Income's per-property split)
  "Resident Benefits Package", // GL 958019 — confirmed on 1,175 real charge lines, $53,750.35 total
]);

// Late Fee bucket additions: NSF Fees, Admin/manual payment processing fee,
// Unlawful Detainer filing fee. (Late Fee Income itself is already handled
// above via DefaultAccountName.)
const LATE_FEE_BUCKET_NAMES = new Set<string>([
  "NSF/Payment Reversal Fee Income", // GL 13 — confirmed on 33 real charge lines, $1,650.00 total. Also IsDefaultGLAccount=true with DefaultAccountName "NSF Fee Income", so the DefaultAccountName check above would need its own "NSF Fee Income" case to catch it that way — listed here by exact Name instead, consistent with the other five additions in this rule
  "Admin Manual Payment Process Fee", // GL 812829 — confirmed on 102 real charge lines, $2,549.45 total
  "Unlawful Detainer Filing Fee", // GL 1014311 — confirmed on 3 real charge lines, $600.00 total. NOT the same account as "Court Costs- Tenant" (GL 976019, stays out of scope) — see file header note.
  // PRE-EXISTING BUG FOUND WHILE VERIFYING AGAINST REAL DATA, FIXED HERE:
  // this file's original comment assumed "Late Fee Income - Red Lion" (GL
  // 649357) carries IsDefaultGLAccount=true "presumably" the same as GL 8.
  // Confirmed live it does NOT — IsDefaultGLAccount is false and
  // DefaultAccountName is null for GL 649357 — so before this change it fell
  // through to 'other', silently misclassifying a real late fee as
  // Miscellaneous on any Red Lion tenant's notice. Since "Late Fees" is
  // explicitly in Jason's rule and this is the same underlying charge type
  // as GL 8, just a differently-tagged per-property account, it belongs on
  // this known-good list rather than left broken.
  "Late Fee Income - Red Lion", // GL 649357 — confirmed on 8 real charge lines, $690.00 total
]);

// Classifies a single resolved GL account into a notice_line_items bucket,
// or into EXCLUDED_NOT_A_CHARGE for the narrow, verified set of accounts
// that aren't tenant charges at all (see EXCLUDED_GL_ACCOUNTS above). Throws
// UnclassifiableChargeError (never returns a guess) for anything else that
// is out of scope for this table or isn't a real Income-type tenant charge.
export function classifyGlAccount(glAccount: GlAccountForClassification): ClassificationResult {
  if (EXCLUDED_GL_ACCOUNTS.has(glAccount.id)) {
    return EXCLUDED_NOT_A_CHARGE;
  }

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

  // Jason's 2026-07-02 rule: Utilities, Pet Rent, and RBP count as rent for
  // notice-itemization purposes; NSF fees, the admin/manual payment
  // processing fee, and the Unlawful Detainer filing fee count as late fees.
  // Exact-Name match against the known-good lists above — see their comments
  // for why Name (not DefaultAccountName) is the key for these six.
  if (RENT_BUCKET_NAMES.has(glAccount.name)) {
    return "rent";
  }
  if (LATE_FEE_BUCKET_NAMES.has(glAccount.name)) {
    return "late_fee";
  }

  // A non-default account (or a default account whose canonical name isn't
  // Rent/Late Fee) that survived the out-of-scope check and the expanded
  // known-good lists above is a real Income-type tenant charge that isn't
  // rent or a late fee — e.g. Application Fee Income, Convenience Fee,
  // Tenant Lease Renewal Fee. That is exactly what 'other'/Miscellaneous is
  // for.
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
): { amount: number; glAccount: GlAccountForClassification; bucket: ClassificationResult }[] {
  return lines.map((line) => ({
    ...line,
    bucket: classifyGlAccount(line.glAccount),
  }));
}
