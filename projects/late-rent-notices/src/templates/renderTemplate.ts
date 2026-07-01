export interface MergeFields {
  tenant_name: string;
  unit_label: string;
  amount_due: string;
  days_late: string;
  due_date: string;
  notice_date: string;
  property_address: string;
  pm_name: string;
}

// Simple, dependency-free {{field}} substitution. Throws if a placeholder
// has no matching field — a silently-blank merge field in a legal notice
// (e.g. "{{amount_due}}" left literally in the text) is exactly the kind
// of defect that makes a notice defective on its face.
export function renderTemplate(template: string, fields: MergeFields): string {
  const fieldMap = fields as unknown as Record<string, string>;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (!(key in fieldMap)) {
      throw new Error(`renderTemplate: no merge field provided for placeholder "${match}"`);
    }
    return fieldMap[key];
  });
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}
