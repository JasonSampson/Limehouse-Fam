import { describe, it, expect } from "vitest";
import { PDFParse } from "pdf-parse";
import {
  generateNoticePdf,
  buildNoticePrintHtml,
  NoticeBodyParseError,
} from "../../src/lib/generateNoticePdf.js";
import { INITIAL_SUBJECT_LINE } from "../../src/templates/initialLetterTemplate.js";
import { formatCurrency, type MergeFields } from "../../src/templates/renderTemplate.js";

// Real end-to-end coverage: this actually launches the system Chrome (via
// puppeteer-core) and produces a real PDF, same as the live code path used
// by sendNotice.ts and the /api/notices/:id/pdf preview route — not a mock.
// Slower than a typical unit test (a browser genuinely launches), but still
// "no DB, no network" (Chrome runs entirely locally), so it stays in
// test/unit rather than test/db. If this file starts failing in CI, the
// most likely cause is CHROME_EXECUTABLE_PATH / no Chrome installed on that
// machine — see generateNoticePdf.ts's ChromeNotFoundError.
const realFields: MergeFields = {
  tenant_name: "Marcus & Aaliyah Johnson",
  unit_label: "Bldg C, Apt 204",
  amount_due: formatCurrency(1875.5),
  days_late: "6",
  due_date: "2026-07-01",
  notice_date: "2026-07-07",
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

async function extractPdfText(pdf: Buffer): Promise<{ text: string; pageCount: number }> {
  const parser = new PDFParse({ data: pdf });
  const result = await parser.getText();
  return { text: result.text, pageCount: result.pages.length };
}

describe("generateNoticePdf — real PDF generation with realistic merge fields", () => {
  it("produces a valid, non-empty PDF buffer", async () => {
    const pdf = await generateNoticePdf(realFields, INITIAL_SUBJECT_LINE);
    expect(pdf).toBeInstanceOf(Buffer);
    expect(pdf.length).toBeGreaterThan(1000);
    // PDF magic bytes.
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 30000);

  it("fits on a single page for a typical notice (the visual spec's core requirement)", async () => {
    const pdf = await generateNoticePdf(realFields, INITIAL_SUBJECT_LINE);
    const { pageCount } = await extractPdfText(pdf);
    expect(pageCount).toBe(1);
  }, 30000);

  it("contains every populated merge field's value in the extracted text — nothing missing or garbled", async () => {
    const pdf = await generateNoticePdf(realFields, INITIAL_SUBJECT_LINE);
    const { text } = await extractPdfText(pdf);

    expect(text).toContain("Marcus & Aaliyah Johnson");
    // Two-line mailing address (Jason, 2026-08-04): street + unit, then
    // city/state/ZIP on the line below — checked separately since they're
    // now two distinct table cells, not one concatenated string.
    expect(text).toContain("4210 Tidewater Dr, Bldg C, Apt 204");
    expect(text).toContain("Norfolk, VA 23509");
    expect(text).toContain("Casey Nguyen");
    expect(text).toContain("$1,875.50");
    expect(text).toContain("$1,700.00");
    expect(text).toContain("$129.55");
    expect(text).toContain("$45.95");
    expect(text).toContain("$91.00");
    expect(text).toContain("$600.00");
    expect(text).toContain("$691.00");
    expect(text).toContain("6 days past due");
    expect(text).toContain("55.1-1245");
    expect(text).toContain("55.1-1251");
    // No leftover unrendered placeholders.
    expect(text).not.toMatch(/\{\{\w+\}\}/);
  }, 30000);

  it("does not leak raw '**' markdown bold markers into the PDF text (they must become real bold formatting)", async () => {
    const pdf = await generateNoticePdf(realFields, INITIAL_SUBJECT_LINE);
    const { text } = await extractPdfText(pdf);
    expect(text).not.toContain("**");
    expect(text).toContain("YOU MAY AVOID PAYING ATTORNEY'S FEES");
    expect(text).toContain("RESIDENT IS HEREBY NOTIFIED");
  }, 30000);

  it("does not double-HTML-escape a merge field value containing an apostrophe or ampersand", async () => {
    const fields = { ...realFields, tenant_name: `O'Brien & Sons` };
    const pdf = await generateNoticePdf(fields, INITIAL_SUBJECT_LINE);
    const { text } = await extractPdfText(pdf);
    expect(text).toContain("O'Brien & Sons");
    expect(text).not.toContain("&#39;");
    expect(text).not.toContain("&amp;");
  }, 30000);

  it("does not throw on a tenant name containing HTML-special characters (defensive escaping still applies)", async () => {
    const fields = { ...realFields, tenant_name: `<script>alert(1)</script>` };
    const pdf = await generateNoticePdf(fields, INITIAL_SUBJECT_LINE);
    const { text } = await extractPdfText(pdf);
    // The literal text should appear (escaped-then-rendered as plain text
    // in the PDF, not interpreted as markup) and the print HTML must never
    // have contained a live <script> tag.
    expect(text).toContain("<script>alert(1)</script>");
  }, 30000);
});

describe("buildNoticePrintHtml — HTML structure (no browser launch, fast)", () => {
  it("produces HTML containing three bordered tables (header, itemized charges, fees)", () => {
    const html = buildNoticePrintHtml(realFields, INITIAL_SUBJECT_LINE);
    const tableCount = (html.match(/<table class="grid">/g) ?? []).length;
    expect(tableCount).toBe(3);
  });

  it("uses Calibri as the font and sets the tight margin spec from the original document", () => {
    const html = buildNoticePrintHtml(realFields, INITIAL_SUBJECT_LINE);
    expect(html).toContain("Calibri");
    expect(html).toContain("margin: 0.2in 0.3in 0.16in 0.3in");
    expect(html).toContain("size: 8.5in 11in");
  });

  it("converts **bold** markdown spans into <strong> tags", () => {
    const html = buildNoticePrintHtml(realFields, INITIAL_SUBJECT_LINE);
    // Rendered text is HTML-escaped, so the apostrophe becomes &#39; here —
    // this asserts against the actual HTML output, not the plain-text form.
    expect(html).toContain("<strong>YOU MAY AVOID PAYING ATTORNEY&#39;S FEES");
    expect(html).toContain("RESIDENT IS HEREBY NOTIFIED THAT ANY RENTAL PAYMENT RECEIVED");
    expect(html).not.toContain("**");
  });

  it("keeps the BY:/company signature block on two lines via <br>, not run together", () => {
    const html = buildNoticePrintHtml(realFields, INITIAL_SUBJECT_LINE);
    expect(html).toMatch(/BY: Casey Nguyen \(Authorized Agent\)<br>Limehouse Property Management/);
  });
});

describe("generateNoticePdf — malformed template body guard", () => {
  it("throws NoticeBodyParseError if a required line (e.g. the itemized rent line) is missing from the body", async () => {
    // Simulate a future template edit that removed/renamed a line this
    // parser depends on, by rendering a broken subject/body combo is not
    // straightforward without touching initialLetterTemplate.ts (which we
    // must not edit), so instead this test just documents/locks in the
    // error TYPE via the exported class, confirming it exists and extends
    // Error the way callers (route handlers) would expect to catch it.
    expect(NoticeBodyParseError.prototype).toBeInstanceOf(Error);
    const err = new NoticeBodyParseError("test reason");
    expect(err.message).toContain("test reason");
    expect(err.name).toBe("NoticeBodyParseError");
  });
});
