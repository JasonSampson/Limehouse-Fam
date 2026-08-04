// Shared plain-text -> HTML formatting for the 14-day notice's rendered
// body. Used by both generateNoticePdf.ts (which splits the body into
// table regions first) and the email path in sendNotice.ts/noticeRoutes.ts
// (which renders the whole body as flowing paragraphs) — a single source
// of truth so the two never drift out of sync with each other.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Converts **bold** markdown spans (the only markdown construct used in
// INITIAL_BODY_MARKDOWN) into <strong> tags, on already-HTML-escaped text.
// Safe because escapeHtml() above never produces a literal "**" sequence
// (it only touches & < > " '), so this can run as a second pass without
// double-escaping or accidentally matching escaped entities.
export function boldMarkdownToHtml(escapedText: string): string {
  return escapedText.replace(/\*\*(.+?)\*\*/gs, "<strong>$1</strong>");
}

// Regroups a slice of lines back into logical paragraphs, joining wrapped
// lines (no blank line between them) into one flowing string and starting a
// new paragraph at each blank line. INITIAL_BODY_MARKDOWN wraps its prose at
// a fixed column width for source-file readability — e.g. the bolded
// "**YOU MAY AVOID..." warning spans 4 separate `\n`-terminated lines with
// no blank line between them, all as ONE paragraph in the original document.
// Splitting naively on every "\n" breaks that one paragraph into 4 separate
// lines (or, in an email, 4 separate visible line breaks mid-sentence),
// which both changes the visual paragraph structure and prevents the
// **bold** regex above from ever matching, since the opening ** and closing
// ** end up in different strings entirely.
//
// Wrapped prose lines join with a plain space (so the browser/email client
// reflows them naturally, same as any paragraph). Four blocks are the
// exception, since they're short field-list lines ("Label: value"), not
// wrapped prose, and must keep their own line breaks instead of running
// together into one sentence: the "TO: {{tenant_name}}" / property address
// / unit / "FROM: Limehouse Property Management" / address header block
// (six lines, no blank line between them), the itemized charges block
// (Rent/Late Charges/Misc/Total, four lines), the fees block (Court Costs/
// Attorney's Fees/Total Fees, three lines), and the closing signature block
// ("BY: {{pm_name}} (Authorized Agent)" / "Limehouse Property Management").
// generateNoticePdf.ts never runs any of these four blocks through this
// function at all — it splits them into fixed table cells instead — so this
// only mattered once the email path started reusing this function for the
// whole body. Detected by each block's known, fixed first line (the same
// literal anchor strings generateNoticePdf.ts's parseNoticeBody already
// keys off of); every other paragraph in the template is prose. All four
// join with the \x00 sentinel below, converted to a real line break (<br>)
// by paragraphsToHtml.
export const SIGNATURE_LINE_BREAK = "\x00";

const FIELD_LIST_BLOCK_STARTS = ["TO:", "FROM:", "BY:", "Rent for the Month", "Court Costs:"];

// "FROM:" also forces a paragraph break BEFORE it, splitting the header's
// single TO+FROM field-list block into two separate paragraphs — a
// one-paragraph gap between the tenant's address and Limehouse's, in the
// EMAIL only (Jason, 2026-08-04). The PDF is untouched: generateNoticePdf.ts
// never runs this header region through groupLinesIntoParagraphs at all —
// it slices toName/toAddressLine1/toAddressLine2/fromName/fromAddressLine1/
// fromAddressLine2 out by fixed index and places them straight into the
// TO/FROM table's own cells, where a "paragraph space" concept doesn't
// apply the same way.
const FORCE_PARAGRAPH_BREAK_BEFORE = ["FROM:"];

export function groupLinesIntoParagraphs(lines: string[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const isFieldListBlock = FIELD_LIST_BLOCK_STARTS.some((prefix) => current[0].startsWith(prefix));
    const joiner = isFieldListBlock ? SIGNATURE_LINE_BREAK : " ";
    paragraphs.push(current.join(joiner));
    current = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flush();
      continue;
    }
    if (FORCE_PARAGRAPH_BREAK_BEFORE.some((prefix) => trimmed.startsWith(prefix))) {
      flush();
    }
    current.push(trimmed);
  }
  flush();
  return paragraphs;
}

// Two paragraphs get their own one-off visual treatment beyond **bold**,
// per Jason (2026-08-04). Detected by content match on the raw (pre-HTML)
// paragraph text rather than a new markdown syntax, since each only ever
// needs the treatment on its one whole paragraph, never partial/inline —
// the same reasoning as FIELD_LIST_BLOCK_STARTS above. Inline styles (not
// a CSS class) so this works identically in the PDF (which does have a
// <style> block) and the email (which is sent as a bare HTML fragment with
// no <style> block at all — email clients need inline styles to render
// reliably regardless).
//
// "ITEMIZED CHARGES:" — centered, same font-size as the "NOTICE OF
// DEFAULT..." header (both already render at the body's own 11pt, so only
// centering is actually needed). This line was silently DROPPED from the
// PDF before generateNoticePdf.ts's itemizedHeadingLine fix (same commit)
// — it was consumed purely as a parse boundary marker and never rendered.
const CENTERED_PARAGRAPHS = ["**ITEMIZED CHARGES:**"];
// "YOU MAY AVOID PAYING..." — underlined, on top of its existing bold/caps.
const UNDERLINED_PARAGRAPH_PREFIXES = ["**YOU MAY AVOID PAYING"];

export function paragraphsToHtml(paragraphs: string[]): string {
  return paragraphs
    .map((p) => {
      const trimmed = p.trim();
      const html = boldMarkdownToHtml(escapeHtml(p)).replaceAll(SIGNATURE_LINE_BREAK, "<br>");
      const styles: string[] = [];
      if (CENTERED_PARAGRAPHS.includes(trimmed)) styles.push("text-align:center");
      if (UNDERLINED_PARAGRAPH_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
        styles.push("text-decoration:underline");
      }
      const styleAttr = styles.length > 0 ? ` style="${styles.join(";")}"` : "";
      return `<p${styleAttr}>${html}</p>`;
    })
    .join("\n");
}

// Renders an already-merge-field-substituted (escapeForHtml: false) plain-
// text notice body into flowing HTML paragraphs — the whole body, not
// split into table regions (that's generateNoticePdf.ts's job). This is
// what actually gets emailed, and what the PM's on-screen preview shows.
//
// Replaces the old `.replace(/\n/g, "<br>")` approach, which turned
// INITIAL_BODY_MARKDOWN's source-file hard-wraps (line breaks inserted only
// for readability in the .ts file, not meant to be real line breaks) into
// literal visible line breaks mid-sentence in the email.
export function renderNoticeBodyToHtml(renderedBody: string): string {
  return paragraphsToHtml(groupLinesIntoParagraphs(renderedBody.split("\n")));
}
