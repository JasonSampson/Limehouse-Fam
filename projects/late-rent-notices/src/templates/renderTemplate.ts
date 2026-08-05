export interface MergeFields {
  tenant_name: string;
  unit_label: string;
  amount_due: string;
  days_late: string;
  due_date: string;
  notice_date: string;
  // Two-line mailing-address format Jason requires (2026-08-04): line 1 is
  // the street plus unit ("2642 East Ocean View Avenue, Unit B2" — or just
  // the street at a single-family home, no unit line), line 2 is city,
  // state, and ZIP ("Norfolk, VA 23518"). Together they fill the two blank
  // lines under "TO:" in the letter header, mirroring Limehouse's own two
  // address lines under "FROM:".
  property_address: string;
  property_address_line2: string;
  pm_name: string;
  // Itemized breakdown (migration 0038 / notice_line_items), computed from
  // real classified Buildium charge lines at send time — see sendNotice.ts.
  // Each is a pre-formatted currency string via formatCurrency, same as
  // amount_due, ready to drop straight into the template text.
  rent_amount_due: string;
  late_fee_amount_due: string;
  misc_amount_due: string;
  // Fixed, same-for-every-notice ESTIMATES (migrations 0040/0041,
  // src/lib/config.ts getEstimatedCourtCosts/getEstimatedAttorneyFees) — NOT
  // ledger-derived like the three fields above. These populate the "Court
  // Costs:" / "Attorney's / Filing Fees:" / "TOTAL Fees & Costs:" lines on
  // every notice (no longer day-18-only placeholder text). total_fees_
  // and_costs_amount is a simple sum of the other two, computed by the
  // caller — this module does no arithmetic of its own.
  court_costs_amount: string;
  attorney_fees_amount: string;
  total_fees_and_costs_amount: string;
}

// Sentinel finding: merge field values (e.g. a tenant's full_name pulled
// from Buildium) were substituted into bodyHtml with no escaping. A name
// containing "<" or "&" — a real possibility with data entered by someone
// else, not under this app's control — could break the rendered HTML
// structure. Values are escaped before substitution; the template TEXT
// itself is untouched by this function.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Simple, dependency-free {{field}} substitution. Throws if a placeholder
// has no matching field — a silently-blank merge field in a legal notice
// (e.g. "{{amount_due}}" left literally in the text) is exactly the kind
// of defect that makes a notice defective on its face.
//
// escapeForHtml defaults to true (the safe default for the letter body,
// which becomes bodyHtml). The one caller that renders a plain-text email
// SUBJECT line (not HTML) must pass escapeForHtml: false — otherwise a name
// like "O'Brien" would literally show "O&#39;Brien" in the subject, since
// subject headers are never HTML-decoded by the mail client.
// Generic over the field-map shape (defaults to MergeFields, so every
// existing call site is unaffected) — the cover email template
// (coverEmailTemplate.ts) has its own distinct, smaller set of fields
// unrelated to the legal notice's, and reuses this same substitution/
// escaping logic rather than a second hand-rolled implementation.
export function renderTemplate<T extends object = MergeFields>(
  template: string,
  fields: T,
  options: { escapeForHtml?: boolean } = {}
): string {
  const escapeForHtml = options.escapeForHtml ?? true;
  const fieldMap = fields as unknown as Record<string, string>;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (!(key in fieldMap)) {
      throw new Error(`renderTemplate: no merge field provided for placeholder "${match}"`);
    }
    const value = fieldMap[key];
    return escapeForHtml ? escapeHtml(value) : value;
  });
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

// Dates render as MM/DD/YYYY everywhere a person sees them (notices,
// emails, dashboard) — Jason's standard. Storage stays ISO (YYYY-MM-DD)
// in the database; this is presentation only. UTC parts, matching how
// due dates are computed (calculateLateness works in UTC midnight terms).
export function formatDateMMDDYYYY(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${date.getUTCFullYear()}`;
}

// Joins tenant names into one readable list for a single combined notice
// email ("Jane Doe", "Jane Doe and John Doe", "Jane Doe, John Doe, and Mary
// Doe"). Jason confirmed one combined email to every tenant on the lease is
// fine, in place of a separate email per tenant. Lives here (not
// sendNotice.ts, where it originated) so coverEmailFormatting.ts can reuse
// its joining convention for first-names-only greetings without a circular
// import between the two.
export function formatTenantNameList(names: string[]): string {
  if (names.length === 0) return "Tenant";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}
