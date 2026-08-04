import { describe, it, expect } from "vitest";
import { renderTemplate, formatCurrency, type MergeFields } from "../../src/templates/renderTemplate.js";
import { INITIAL_BODY_MARKDOWN } from "../../src/templates/initialLetterTemplate.js";
import { renderNoticeBodyToHtml } from "../../src/lib/noticeBodyFormatting.js";

// Root cause of the bug Jason reported ("the words are a complete sentence
// and half way on the line it jumps to the next line"): INITIAL_BODY_MARKDOWN
// hard-wraps its prose at a fixed column width for source-file readability,
// and the email path used to do a blind `.replace(/\n/g, "<br>")`, turning
// every one of those source-file line breaks into a real, visible line
// break mid-sentence. renderNoticeBodyToHtml replaces that with the same
// paragraph-reflow logic generateNoticePdf.ts already used for the PDF.
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

function renderRealBody(): string {
  const renderedBody = renderTemplate(INITIAL_BODY_MARKDOWN, realFields, { escapeForHtml: false });
  return renderNoticeBodyToHtml(renderedBody);
}

describe("renderNoticeBodyToHtml — the real 14-day notice body", () => {
  it("keeps a wrapped prose paragraph as ONE <p>, not split across multiple <br>-separated lines", () => {
    const html = renderRealBody();
    // This sentence spans 4 separate lines in INITIAL_BODY_MARKDOWN's source
    // file (wrapped for readability only) with no blank line between them —
    // it must render as one continuous paragraph, not four visible lines.
    const warningParagraph = html
      .split("\n")
      .find((line) => line.includes("YOU MAY AVOID PAYING ATTORNEY"));
    expect(warningParagraph).toBeDefined();
    expect(warningParagraph).not.toContain("<br>");
    expect(warningParagraph).toContain("PERSONAL CHECKS WILL NOT BE ACCEPTED.");
  });

  it("does not insert any <br> inside prose paragraphs at all — only real paragraph breaks (<p>) separate them", () => {
    const html = renderRealBody();
    // <p[ or <p> — some paragraphs now carry a style attribute (centered/
    // underlined special cases below), so a bare `<p>` prefix check would
    // silently skip them.
    const paragraphs = html.split("\n").filter((line) => /^<p[ >]/.test(line));
    // Exactly the 4 known field-list blocks (header, itemized, fees,
    // signature) legitimately contain <br>; every other paragraph must not.
    const proseParagraphsWithBr = paragraphs.filter(
      (p) => p.includes("<br>") && !/^<p>(TO:|FROM:|BY:|Rent for the Month|Court Costs:)/.test(p)
    );
    expect(proseParagraphsWithBr).toEqual([]);
  });

  // TO and FROM render as two SEPARATE paragraphs, not one six-line block —
  // a one-paragraph gap between the tenant's address and Limehouse's
  // (Jason, 2026-08-04), matching how every other paragraph break in this
  // email is a distinct <p>. The PDF is unaffected — it never routes this
  // header region through groupLinesIntoParagraphs (see that function's
  // FORCE_PARAGRAPH_BREAK_BEFORE comment).
  it("splits the TO and FROM address blocks into two separate paragraphs, each keeping its own three lines", () => {
    const html = renderRealBody();
    const lines = html.split("\n");
    const toParagraph = lines.find((line) => line.startsWith("<p>TO:"));
    const fromParagraph = lines.find((line) => line.startsWith("<p>FROM:"));

    expect(toParagraph).toBeDefined();
    expect(toParagraph!.match(/<br>/g)).toHaveLength(2); // 3 lines = 2 breaks
    expect(toParagraph).toContain("Marcus &amp; Aaliyah Johnson<br>4210 Tidewater Dr");
    expect(toParagraph).not.toContain("FROM:");

    expect(fromParagraph).toBeDefined();
    expect(fromParagraph!.match(/<br>/g)).toHaveLength(2); // 3 lines = 2 breaks
    expect(fromParagraph).toContain("FROM: Limehouse Property Management<br>6056 Providence Rd");

    // The two are genuinely separate paragraph elements, giving the email
    // client its own default spacing between them — not one block with an
    // extra <br> in the middle.
    expect(toParagraph).not.toBe(fromParagraph);
  });

  it("keeps the itemized charges block as four separate lines", () => {
    const html = renderRealBody();
    const itemizedParagraph = html.split("\n").find((line) => line.startsWith("<p>Rent for the Month"));
    expect(itemizedParagraph).toBeDefined();
    expect(itemizedParagraph!.match(/<br>/g)).toHaveLength(3); // 4 lines = 3 breaks
    expect(itemizedParagraph).toContain("$1,700.00<br>Late Charges");
  });

  it("keeps the fees block as three separate lines", () => {
    const html = renderRealBody();
    const feesParagraph = html.split("\n").find((line) => line.startsWith("<p>Court Costs:"));
    expect(feesParagraph).toBeDefined();
    expect(feesParagraph!.match(/<br>/g)).toHaveLength(2); // 3 lines = 2 breaks
  });

  it("keeps the signature block on two lines via <br>", () => {
    const html = renderRealBody();
    expect(html).toMatch(/BY: Casey Nguyen \(Authorized Agent\)<br>Limehouse Property Management/);
  });

  it("converts **bold** markdown spans into <strong> tags, with no literal ** left over", () => {
    const html = renderRealBody();
    expect(html).toContain("<strong>NOTICE OF DEFAULT");
    expect(html).toContain("<strong>ITEMIZED CHARGES:</strong>");
    expect(html).not.toContain("**");
  });

  // Jason's correction on 2026-08-04 after reviewing a real notice: the
  // Buildium-portal sentence (added 2026-08-01, never approved by the
  // attorney) is gone, restoring the payment-method paragraph to the
  // attorney's exact verbatim wording.
  it("no longer contains the Buildium tenant portal sentence", () => {
    const html = renderRealBody();
    expect(html).not.toContain("Buildium tenant portal");
    expect(html).not.toContain("As a convenience");
  });

  it("underlines the YOU MAY AVOID PAYING paragraph, on top of its existing bold/caps", () => {
    const html = renderRealBody();
    const warningParagraph = html.split("\n").find((line) => line.includes("YOU MAY AVOID PAYING ATTORNEY"));
    expect(warningParagraph).toBeDefined();
    expect(warningParagraph).toMatch(/^<p style="text-decoration:underline">/);
    expect(warningParagraph).toContain("<strong>YOU MAY AVOID PAYING");
  });

  it("centers the ITEMIZED CHARGES heading", () => {
    const html = renderRealBody();
    const heading = html.split("\n").find((line) => line.includes("ITEMIZED CHARGES"));
    expect(heading).toBeDefined();
    expect(heading).toMatch(/^<p style="text-align:center">/);
  });

  it("bolds the whole 'Any partial payment of rent made...' paragraph", () => {
    const html = renderRealBody();
    const paragraph = html.split("\n").find((line) => line.includes("Any partial payment of rent made"));
    expect(paragraph).toBeDefined();
    expect(paragraph).toMatch(/^<p><strong>Any partial payment of rent made/);
    expect(paragraph).toContain("per 55.1-1250.</strong></p>");
  });

  it("bolds only the first two sentences of the credit-bureau paragraph, not the Legal Aid Society sentence", () => {
    const html = renderRealBody();
    const paragraph = html.split("\n").find((line) => line.includes("Judgements are immediately"));
    expect(paragraph).toBeDefined();
    expect(paragraph).toContain(
      "<strong>Judgements are immediately reported to the credit bureau. Act now to protect your credit.</strong> Please direct your questions"
    );
    expect(paragraph).toContain("Legal Aid Society with any questions at 757-627-5423.");
  });

  it("HTML-escapes merge field values (ampersand, apostrophe) exactly once", () => {
    const html = renderRealBody();
    expect(html).toContain("Marcus &amp; Aaliyah Johnson");
    expect(html).not.toContain("&amp;amp;");
    expect(html).toContain("attorney&#39;s fees");
  });
});
