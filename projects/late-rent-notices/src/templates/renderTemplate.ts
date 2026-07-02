export interface MergeFields {
  tenant_name: string;
  unit_label: string;
  amount_due: string;
  days_late: string;
  due_date: string;
  notice_date: string;
  property_address: string;
  pm_name: string;
  // Itemized breakdown (migration 0038 / notice_line_items), computed from
  // real classified Buildium charge lines at send time — see sendNotice.ts.
  // Each is a pre-formatted currency string via formatCurrency, same as
  // amount_due, ready to drop straight into the template text.
  rent_amount_due: string;
  late_fee_amount_due: string;
  misc_amount_due: string;
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
export function renderTemplate(
  template: string,
  fields: MergeFields,
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
