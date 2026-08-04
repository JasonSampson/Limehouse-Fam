import { describe, it, expect } from "vitest";
import { renderTemplate, formatCurrency, type MergeFields } from "../../src/templates/renderTemplate.js";
import {
  INITIAL_BODY_MARKDOWN,
  INITIAL_SUBJECT_LINE,
  INITIAL_TEMPLATE_KEY,
  INITIAL_TEMPLATE_VERSION,
} from "../../src/templates/initialLetterTemplate.js";

const baseFields: MergeFields = {
  tenant_name: "Jane Doe",
  unit_label: "Unit 4B",
  amount_due: "$1,500.00",
  days_late: "10",
  due_date: "July 2026",
  notice_date: "July 15, 2026",
  property_address: "123 Main St, Unit 4B",
  property_address_line2: "Norfolk, VA 23508",
  pm_name: "Alex Rivera",
  rent_amount_due: "$1,350.00",
  late_fee_amount_due: "$150.00",
  misc_amount_due: "$0.00",
  court_costs_amount: "$91.00",
  attorney_fees_amount: "$600.00",
  total_fees_and_costs_amount: "$691.00",
};

describe("renderTemplate — merge field substitution", () => {
  it("substitutes every merge field placeholder with its value", () => {
    const result = renderTemplate("Hello {{tenant_name}}, unit {{unit_label}}", baseFields);
    expect(result).toBe("Hello Jane Doe, unit Unit 4B");
  });

  it("substitutes the same field appearing multiple times in the template", () => {
    const result = renderTemplate("{{tenant_name}} - {{tenant_name}}", baseFields);
    expect(result).toBe("Jane Doe - Jane Doe");
  });

  it("throws when the template references a placeholder with no matching field", () => {
    expect(() => renderTemplate("Hello {{nonexistent_field}}", baseFields)).toThrow(
      /no merge field provided for placeholder "\{\{nonexistent_field\}\}"/
    );
  });

  it("leaves text with no placeholders untouched", () => {
    const result = renderTemplate("No placeholders here.", baseFields);
    expect(result).toBe("No placeholders here.");
  });
});

describe("renderTemplate — HTML escaping (default / bodyHtml path)", () => {
  it("escapes an ampersand in a merge field value", () => {
    const fields = { ...baseFields, tenant_name: "Smith & Sons LLC" };
    const result = renderTemplate("{{tenant_name}}", fields);
    expect(result).toBe("Smith &amp; Sons LLC");
  });

  it("escapes angle brackets in a merge field value", () => {
    const fields = { ...baseFields, tenant_name: "<b>Jane</b>" };
    const result = renderTemplate("{{tenant_name}}", fields);
    expect(result).toBe("&lt;b&gt;Jane&lt;/b&gt;");
  });

  it("escapes quotes in a merge field value", () => {
    const fields = { ...baseFields, tenant_name: `O'Brien "The Tenant"` };
    const result = renderTemplate("{{tenant_name}}", fields);
    expect(result).toBe("O&#39;Brien &quot;The Tenant&quot;");
  });

  it("does NOT escape the surrounding template text itself, only substituted values", () => {
    const result = renderTemplate("<b>{{tenant_name}}</b>", baseFields);
    expect(result).toBe("<b>Jane Doe</b>");
  });
});

describe("renderTemplate — XSS-shaped input handling", () => {
  it("neutralizes a <script> tag injected via a merge field", () => {
    const fields = { ...baseFields, tenant_name: `<script>alert('xss')</script>` };
    const result = renderTemplate("{{tenant_name}}", fields);
    expect(result).not.toContain("<script>");
    expect(result).toBe("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
  });

  it("neutralizes an inline event-handler injection attempt via a merge field", () => {
    const fields = { ...baseFields, tenant_name: `" onmouseover="alert(1)` };
    const result = renderTemplate('<span title="{{tenant_name}}">', fields);
    // The quote that would have broken out of the attribute is escaped, so
    // the injected onmouseover stays inert text inside the attribute value.
    expect(result).toBe('<span title="&quot; onmouseover=&quot;alert(1)">');
  });

  it("neutralizes a closing-tag-injection attempt in a real notice render (full body)", () => {
    const fields = { ...baseFields, tenant_name: `</p><script>document.location='http://evil.example'</script><p>` };
    const rendered = renderTemplate(INITIAL_BODY_MARKDOWN, fields);
    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain("&lt;script&gt;");
  });
});

describe("renderTemplate — subject-line-not-escaped behavior (escapeForHtml: false)", () => {
  // As of template v5 the subject line contains no merge fields (Jason
  // dropped the unit label from it), so the escaping-mode split is proven
  // against a plain field template instead.
  it("does NOT HTML-escape when escapeForHtml is explicitly false", () => {
    const fields = { ...baseFields, unit_label: `O'Brien's Unit` };
    const result = renderTemplate("Unit: {{unit_label}}", fields, { escapeForHtml: false });
    expect(result).toBe("Unit: O'Brien's Unit");
    expect(result).not.toContain("&#39;");
  });

  it("HTML-escapes by default (escapeForHtml omitted) for the same input, proving the two modes actually differ", () => {
    const fields = { ...baseFields, unit_label: `O'Brien's Unit` };
    const result = renderTemplate("Unit: {{unit_label}}", fields);
    expect(result).toContain("&#39;");
  });

  it("the v5 subject line is a constant with no merge fields and no unit label", () => {
    expect(INITIAL_SUBJECT_LINE).toBe("NOTICE OF DEFAULT — FAILURE TO PAY RENT");
    expect(INITIAL_SUBJECT_LINE).not.toMatch(/\{\{/);
  });
});

describe("renderTemplate — full initial notice letter (v6, actual attorney-sourced template)", () => {
  it("is the expected template key/version this test suite is pinned against", () => {
    expect(INITIAL_TEMPLATE_KEY).toBe("14_day_pay_or_quit");
    expect(INITIAL_TEMPLATE_VERSION).toBe(6);
  });

  it("renders the full body with realistic tenant data and contains every populated field's value", () => {
    const fields: MergeFields = {
      tenant_name: "Marcus & Aaliyah Johnson",
      unit_label: "Bldg C, Apt 204",
      amount_due: formatCurrency(1875.5),
      days_late: "6",
      due_date: "07/01/2026",
      notice_date: "07/07/2026",
      // Standard two-line mailing address (Jason, 2026-08-04): street +
      // unit on line 1, city/state/ZIP on line 2.
      property_address: "4210 Tidewater Dr, Bldg C, Apt 204",
      property_address_line2: "Norfolk, VA 23509",
      pm_name: "Casey Nguyen",
      rent_amount_due: formatCurrency(1700),
      late_fee_amount_due: formatCurrency(129.55),
      misc_amount_due: formatCurrency(45.95),
      court_costs_amount: formatCurrency(91),
      attorney_fees_amount: formatCurrency(600),
      total_fees_and_costs_amount: formatCurrency(691),
    };
    const rendered = renderTemplate(INITIAL_BODY_MARKDOWN, fields);

    expect(rendered).toContain("Marcus &amp; Aaliyah Johnson");
    expect(rendered).toContain("Bldg C, Apt 204");
    expect(rendered).toContain("$1,875.50");
    expect(rendered).toContain("6 days past due");
    expect(rendered).toContain("Casey Nguyen");
    expect(rendered).toContain("55.1-1245");
    expect(rendered).toContain("55.1-1251");
    expect(rendered).toContain("$1,700.00");
    expect(rendered).toContain("$129.55");
    expect(rendered).toContain("$45.95");
    // Court Costs / Attorney's Fees / TOTAL are no longer placeholder text
    // (v3 change, migrations 0040/0041) — assert the real rendered amounts,
    // not just that the fields exist.
    expect(rendered).toContain("Court Costs: $91.00");
    expect(rendered).toContain("Attorney's / Filing Fees: $600.00");
    expect(rendered).toContain("TOTAL Fees & Costs: $691.00");
    expect(rendered).not.toContain("N/A — assessed upon referral to attorney");
    // No leftover unrendered placeholders anywhere in the output.
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
  });

  it("throws rather than silently rendering a blank if a required field is missing (defective-notice guard)", () => {
    const incompleteFields = { ...baseFields } as Partial<MergeFields>;
    delete incompleteFields.amount_due;
    expect(() => renderTemplate(INITIAL_BODY_MARKDOWN, incompleteFields as MergeFields)).toThrow();
  });
});

describe("formatCurrency", () => {
  it("formats a whole-dollar amount with two decimal places and a dollar sign", () => {
    expect(formatCurrency(1500)).toBe("$1,500.00");
  });
  it("formats a fractional-cent-free amount correctly", () => {
    expect(formatCurrency(1875.5)).toBe("$1,875.50");
  });
  it("formats zero correctly", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });
});
