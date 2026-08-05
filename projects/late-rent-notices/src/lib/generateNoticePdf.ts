// Generates the 14-Day Notice as a print-formatted PDF, matching the exact
// visual layout of Limehouse's attorney-drafted paper form (extracted
// directly from that document's own XML: US Letter, tight 0.2"/0.3"/0.16"/
// 0.3" margins, Calibri 11pt body text, three plain-black-grid-line tables)
// so a judge who's used to seeing this notice on paper sees the same layout
// when it's printed from this system.
//
// Approach: puppeteer-core (NOT full puppeteer) driving the Chrome that's
// already installed on this machine/server, rather than bundling and
// managing Chromium's own ~300MB download. This project already has a
// working HTML rendering path (renderTemplate.ts -> bodyHtml); this module
// builds a SEPARATE print-specific HTML+CSS template that reproduces the
// attorney form's table/border/font/margin spec, then rasterizes that HTML
// to a PDF via headless Chrome. Verified working on this Windows dev machine
// against C:\Program Files\Google\Chrome\Application\chrome.exe.
//
// Wording source of truth: this module does NOT re-type or duplicate any of
// the legally-reviewed prose in initialLetterTemplate.ts. It takes the
// already-rendered plain-text body (the same renderTemplate() output
// sendNotice.ts and noticeRoutes.ts already produce from
// INITIAL_BODY_MARKDOWN) and mechanically splits it into the three visual
// regions (header block / itemized charges / fees) plus surrounding
// paragraphs, converting **bold** markdown markers to <strong> tags along
// the way. If the attorney's template wording ever changes shape (a line
// added/removed/reordered), this splitter's line-matching should be
// revisited — see parseNoticeBody's doc comment below.
import puppeteer from "puppeteer-core";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "../config/env.js";
import type { MergeFields } from "../templates/renderTemplate.js";
import { renderTemplate } from "../templates/renderTemplate.js";
import { INITIAL_BODY_MARKDOWN } from "../templates/initialLetterTemplate.js";
import { escapeHtml, boldMarkdownToHtml, groupLinesIntoParagraphs, paragraphsToHtml } from "./noticeBodyFormatting.js";

// Self-hosted, never system-dependent: the notice must render with
// Calibri-compatible line widths regardless of what fonts happen to be
// installed on whatever machine runs this. This exact gap — Calibri/Carlito
// present on the Windows machine this was built and tested on, absent on
// the Linux production server — silently pushed every real notice onto a
// second page after go-live (the wider fallback font wrapped fewer words
// per line), spilling only the tiny signature block onto an otherwise-blank
// page 2. Carlito is metrically identical to Calibri (same glyph widths per
// character), so embedding the font file directly here guarantees the same
// line wrapping and page count on every machine, forever, with no server
// setup step required.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARLITO_REGULAR_PATH = path.join(__dirname, "..", "..", "assets", "fonts", "Carlito-Regular.ttf");
const CARLITO_BOLD_PATH = path.join(__dirname, "..", "..", "assets", "fonts", "Carlito-Bold.ttf");

// Node's own path-to-URL converter, not a hand-rolled string replace —
// Windows file URLs need a leading slash before the drive letter
// (file:///C:/...) that a naive backslash-swap silently produces wrong.
function toFileUrl(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

const CARLITO_FONT_FACES = `
    @font-face {
      font-family: 'Carlito';
      src: url('${toFileUrl(CARLITO_REGULAR_PATH)}') format('truetype');
      font-weight: normal;
      font-style: normal;
    }
    @font-face {
      font-family: 'Carlito';
      src: url('${toFileUrl(CARLITO_BOLD_PATH)}') format('truetype');
      font-weight: bold;
      font-style: normal;
    }
  `;

// Common install locations for Chrome/Chromium/Edge, checked in order, used
// only when CHROME_EXECUTABLE_PATH isn't set. Windows dev path is listed
// first since that's this project's current dev environment; the Linux
// paths cover the eventual production server (Scotty's deployment target).
const DEFAULT_CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

export class ChromeNotFoundError extends Error {
  constructor() {
    super(
      "Could not find a Chrome/Chromium executable to generate the notice PDF. " +
        "Set CHROME_EXECUTABLE_PATH in .env to the full path of chrome.exe / google-chrome, or install Chrome."
    );
    this.name = "ChromeNotFoundError";
  }
}

function resolveChromeExecutablePath(): string {
  const env = loadEnv();
  if (env.CHROME_EXECUTABLE_PATH) {
    if (!fs.existsSync(env.CHROME_EXECUTABLE_PATH)) {
      throw new ChromeNotFoundError();
    }
    return env.CHROME_EXECUTABLE_PATH;
  }
  const found = DEFAULT_CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!found) {
    throw new ChromeNotFoundError();
  }
  return found;
}

// Splits the rendered (post-merge-field) plain-text notice body into the
// three visual regions the attorney form uses tables for, plus the
// paragraphs before/between/after them. This is a structural split of
// ALREADY-RENDERED text (merge fields already substituted by renderTemplate,
// same call sendNotice.ts/noticeRoutes.ts make) — it does not alter, retype,
// or paraphrase a single word of the wording itself.
//
// Matched against the literal line structure of INITIAL_BODY_MARKDOWN (see
// that file): the six-line "TO:"/"FROM:" header block, the "ITEMIZED
// CHARGES:" heading followed by 4 fixed lines, and the "Court Costs:"
// heading-less block of 3 fixed lines. If a future template version reorders or renames
// these lines, this function will throw NoticeBodyParseError rather than
// silently mis-render a legal document — a loud failure here is much safer
// than a PDF that quietly drops a dollar figure.
export class NoticeBodyParseError extends Error {
  constructor(message: string) {
    super(`generateNoticePdf: could not parse notice body into PDF layout regions: ${message}`);
    this.name = "NoticeBodyParseError";
  }
}

interface ParsedNoticeBody {
  // Header block: a 3-row, 2-column table in the original document —
  // tenant info on the left, Limehouse's name/address on the right, line
  // for line. See buildPrintHtml for how these six lines become that table.
  toName: string; // "TO: {tenant_name}"
  toAddressLine1: string; // "{property_address}" — street, plus unit where one displays
  toAddressLine2: string; // "{property_address_line2}" — city, state, ZIP
  fromName: string; // "FROM: Limehouse Property Management"
  fromAddressLine1: string; // "6056 Providence Rd, Suite 200"
  fromAddressLine2: string; // "Virginia Beach, VA 23464"
  beforeItemized: string[]; // paragraphs between the header and "ITEMIZED CHARGES:"
  // The literal "**ITEMIZED CHARGES:**" line itself. Previously used ONLY as
  // a parse boundary (itemizedHeadingIdx) and silently dropped — it never
  // appeared anywhere in the rendered PDF, a real gap Jason caught on
  // 2026-08-04. Now captured and rendered (see buildPrintHtml) through the
  // same paragraphsToHtml() the email path uses, so its centered/bold
  // treatment (noticeBodyFormatting.ts's CENTERED_PARAGRAPHS) applies
  // identically in both places from one source of truth.
  itemizedHeadingLine: string;
  itemized: { rentLine: string; lateFeeLine: string; miscLine: string; totalLine: string };
  betweenTables: string[]; // paragraphs between the itemized table and the fees lines
  fees: { courtCostsLine: string; attorneyFeesLine: string; totalFeesLine: string };
  afterFees: string[]; // paragraphs after the fees block through the signature
}

// groupLinesIntoParagraphs (shared with the email path — see
// noticeBodyFormatting.ts) joins INITIAL_BODY_MARKDOWN's source-file
// hard-wrapped lines back into real paragraphs before this module further
// splits some of those paragraph slices into the printed-form's table
// regions below.
function parseNoticeBody(renderedBody: string): ParsedNoticeBody {
  const lines = renderedBody.split("\n");

  const toLineIdx = lines.findIndex((l) => l.trimStart().startsWith("TO:"));
  const fromLineIdx = lines.findIndex((l) => l.trimStart().startsWith("FROM:"));
  const itemizedHeadingIdx = lines.findIndex((l) => l.includes("ITEMIZED CHARGES:"));
  const rentLineIdx = lines.findIndex((l) => l.trimStart().startsWith("Rent for the Month"));
  const lateFeeLineIdx = lines.findIndex((l) => l.trimStart().startsWith("Late Charges for Month"));
  const miscLineIdx = lines.findIndex((l) => l.trimStart().startsWith("Miscellaneous Charges:"));
  const totalDueLineIdx = lines.findIndex((l) => l.trimStart().startsWith("TOTAL DUE LANDLORD"));
  const courtCostsLineIdx = lines.findIndex((l) => l.trimStart().startsWith("Court Costs:"));
  const attorneyFeesLineIdx = lines.findIndex((l) => l.trimStart().startsWith("Attorney's / Filing Fees:"));
  const totalFeesLineIdx = lines.findIndex((l) => l.trimStart().startsWith("TOTAL Fees & Costs:"));

  const requiredIndexes: Record<string, number> = {
    toLine: toLineIdx,
    fromLine: fromLineIdx,
    itemizedHeading: itemizedHeadingIdx,
    rentLine: rentLineIdx,
    lateFeeLine: lateFeeLineIdx,
    miscLine: miscLineIdx,
    totalDueLine: totalDueLineIdx,
    courtCostsLine: courtCostsLineIdx,
    attorneyFeesLine: attorneyFeesLineIdx,
    totalFeesLine: totalFeesLineIdx,
  };
  for (const [name, idx] of Object.entries(requiredIndexes)) {
    if (idx === -1) {
      throw new NoticeBodyParseError(`expected line "${name}" not found in rendered notice body`);
    }
  }
  // The header is exactly six lines: TO:, tenant's address line 1 (street +
  // unit), tenant's address line 2 (city/state/ZIP), FROM:, address line 1,
  // address line 2 — in that fixed order. If a future template edit changes
  // that shape, fail loudly rather than silently misplacing a line into the
  // wrong table cell.
  if (fromLineIdx !== toLineIdx + 3) {
    throw new NoticeBodyParseError(
      `expected exactly 2 lines (address line 1, address line 2) between "TO:" and "FROM:", found ${fromLineIdx - toLineIdx - 1}`
    );
  }

  const beforeItemized = groupLinesIntoParagraphs(lines.slice(fromLineIdx + 3, itemizedHeadingIdx));
  const betweenTables = groupLinesIntoParagraphs(lines.slice(totalDueLineIdx + 1, courtCostsLineIdx));
  const afterFees = groupLinesIntoParagraphs(lines.slice(totalFeesLineIdx + 1));

  return {
    toName: lines[toLineIdx].trim(),
    toAddressLine1: lines[toLineIdx + 1].trim(),
    toAddressLine2: lines[toLineIdx + 2].trim(),
    fromName: lines[fromLineIdx].trim(),
    fromAddressLine1: lines[fromLineIdx + 1].trim(),
    fromAddressLine2: lines[fromLineIdx + 2].trim(),
    beforeItemized,
    itemizedHeadingLine: lines[itemizedHeadingIdx].trim(),
    itemized: {
      rentLine: lines[rentLineIdx].trim(),
      lateFeeLine: lines[lateFeeLineIdx].trim(),
      miscLine: lines[miscLineIdx].trim(),
      totalLine: lines[totalDueLineIdx].trim(),
    },
    betweenTables,
    fees: {
      courtCostsLine: lines[courtCostsLineIdx].trim(),
      attorneyFeesLine: lines[attorneyFeesLineIdx].trim(),
      totalFeesLine: lines[totalFeesLineIdx].trim(),
    },
    afterFees,
  };
}

// Splits a fixed "Label: Value" line (all itemized/fee lines follow this
// shape verbatim in the source template) into its two table cells. Falls
// back to putting the whole line in the label cell if no colon is found —
// this only happens if a future template version changes this line's shape,
// and a slightly-off table cell is far less dangerous than the
// NoticeBodyParseError cases above (no dollar amount is lost either way,
// it's just not split into two columns).
function splitLabelValue(line: string): { label: string; value: string } {
  const idx = line.indexOf(":");
  if (idx === -1) return { label: line, value: "" };
  return { label: line.slice(0, idx + 1).trim(), value: line.slice(idx + 1).trim() };
}

function tableGridCell(text: string): string {
  return `<td>${boldMarkdownToHtml(escapeHtml(text))}</td>`;
}

// Builds the full print HTML document. Table markup mirrors Word's
// "TableGrid" style referenced in the visual spec: every cell gets a thin
// 1px solid black border on all sides, no shading, via a single shared CSS
// class rather than per-cell inline borders.
function buildPrintHtml(parsed: ParsedNoticeBody, subject: string): string {
  const itemizedRent = splitLabelValue(parsed.itemized.rentLine);
  const itemizedLateFee = splitLabelValue(parsed.itemized.lateFeeLine);
  const itemizedMisc = splitLabelValue(parsed.itemized.miscLine);
  const itemizedTotal = splitLabelValue(parsed.itemized.totalLine);

  const feesCourtCosts = splitLabelValue(parsed.fees.courtCostsLine);
  const feesAttorney = splitLabelValue(parsed.fees.attorneyFeesLine);
  const feesTotal = splitLabelValue(parsed.fees.totalFeesLine);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHtml(subject)}</title>
<style>
  ${CARLITO_FONT_FACES}
  @page {
    size: 8.5in 11in;
    /* 0.2in top, 0.3in right, 0.16in bottom, 0.3in left — from the
       original document's DXA margins (288/432/230/432 twentieths of a
       point), converted to inches: 288/1440=0.2, 432/1440=0.3,
       230/1440=0.1597 (~0.16), 432/1440=0.3. */
    margin: 0.2in 0.3in 0.16in 0.3in;
  }
  html, body {
    margin: 0;
    padding: 0;
    /* 'Carlito' first and self-hosted via the @font-face above — guaranteed
       present regardless of the machine. Calibri/Arial stay as a cosmetic
       fallback only, in the unlikely case the embedded font file itself
       fails to load; they should never actually be selected in practice. */
    font-family: 'Carlito', Calibri, Arial, sans-serif;
    font-size: 11pt;
    /* Single-spaced, like the original Word document (which uses 0pt
       space-after and single (1.0) line spacing throughout) rather than a
       browser's default ~1.4-1.5 line-height — the latter is what pushed
       this onto a second page at first. */
    line-height: 1.08;
    color: #000;
  }
  h1.notice-heading {
    font-size: 11pt;
    font-weight: bold;
    text-align: center;
    /* Two blank-line gaps below the title before the TO/FROM header table —
       Jason's second spacing pass (2026-08-04) doubled the first one.
       12pt ≈ one 11pt line at this line-height. */
    margin: 0 0 24pt 0;
  }
  table.grid {
    width: 100%;
    /* table-layout: fixed + the 50%/50% column widths below reproduce the
       original document's own table grid exactly: every one of its three
       tables defines two EQUAL-width gridCols (5231/5231, 5219/5219,
       5189/5189 dxa — verified directly against that document's raw XML).
       Without this, the browser's default auto layout sizes each column by
       its content, so the wide label column crushes the dollar-amount
       column down to barely its own text width — the $ figure ends up
       jammed against the divider line instead of having the same visual
       breathing room the original's even 50/50 split gives it. */
    table-layout: fixed;
    border-collapse: collapse;
    /* No gap above (the gap BEFORE each table comes from the preceding
       paragraph's own bottom margin). Two blank-line gaps below — Jason's
       second spacing pass (2026-08-04) doubled the single gap from the
       first pass. */
    margin: 0 0 24pt 0;
  }
  table.grid td {
    width: 50%;
    border: 1px solid #000;
    padding: 0pt 5pt;
    vertical-align: top;
    font-size: 11pt;
    line-height: 1.08;
  }
  p {
    /* Two blank-line gaps between paragraphs — Jason's second spacing pass
       (2026-08-04) doubled the first pass's single gap, at every spot he
       originally listed. Single-page fit is locked in by the
       generateNoticePdf test suite. */
    margin: 0 0 24pt 0;
  }
  strong {
    font-weight: bold;
  }
</style>
</head>
<body>
  <h1 class="notice-heading">NOTICE OF DEFAULT &ndash; FAILURE TO PAY RENT</h1>

  <table class="grid">
    <tr>${tableGridCell(parsed.toName)}${tableGridCell(parsed.fromName)}</tr>
    <tr>${tableGridCell(parsed.toAddressLine1)}${tableGridCell(parsed.fromAddressLine1)}</tr>
    <tr>${tableGridCell(parsed.toAddressLine2)}${tableGridCell(parsed.fromAddressLine2)}</tr>
  </table>

  ${paragraphsToHtml(parsed.beforeItemized)}

  ${paragraphsToHtml([parsed.itemizedHeadingLine])}

  <table class="grid">
    <tr>${tableGridCell(itemizedRent.label)}${tableGridCell(itemizedRent.value)}</tr>
    <tr>${tableGridCell(itemizedLateFee.label)}${tableGridCell(itemizedLateFee.value)}</tr>
    <tr>${tableGridCell(itemizedMisc.label)}${tableGridCell(itemizedMisc.value)}</tr>
    <tr>${tableGridCell(itemizedTotal.label)}${tableGridCell(itemizedTotal.value)}</tr>
  </table>

  ${paragraphsToHtml(parsed.betweenTables)}

  <table class="grid">
    <tr>${tableGridCell(feesCourtCosts.label)}${tableGridCell(feesCourtCosts.value)}</tr>
    <tr>${tableGridCell(feesAttorney.label)}${tableGridCell(feesAttorney.value)}</tr>
    <tr>${tableGridCell(feesTotal.label)}${tableGridCell(feesTotal.value)}</tr>
  </table>

  ${paragraphsToHtml(parsed.afterFees)}
</body>
</html>`;
}

// Generates the 14-Day Notice PDF for one recipient's merge fields. Renders
// INITIAL_BODY_MARKDOWN through the SAME renderTemplate() call sendNotice.ts
// uses (escapeForHtml defaults to true, matching the email body path) so the
// wording and every dollar figure in the PDF is guaranteed identical to what
// goes out in the email — this function never re-derives or re-types any of
// that text itself.
// Builds the print HTML for a set of merge fields without launching Chrome.
// Exported (in addition to being used internally by generateNoticePdf)
// purely so tests and manual layout diagnostics can inspect the HTML
// directly without paying for a browser launch every time.
export function buildNoticePrintHtml(fields: MergeFields, subjectLine: string): string {
  // escapeForHtml: false — this function does its OWN single HTML-escaping
  // pass (see escapeHtml() calls in buildPrintHtml/tableGridCell/
  // paragraphsToHtml above) as it places each fragment of already-rendered
  // text into the print HTML. Using the default (true) here would escape
  // merge field values TWICE (e.g. "O'Brien" -> "O&#39;Brien" -> literal
  // "O&amp;#39;Brien" on the page) since renderTemplate's escaping is meant
  // for the caller who drops its output straight into raw HTML, not for a
  // caller like this one that re-parses the text and re-escapes it itself.
  const renderedBody = renderTemplate(INITIAL_BODY_MARKDOWN, fields, { escapeForHtml: false });
  const parsed = parseNoticeBody(renderedBody);
  const subject = renderTemplate(subjectLine, fields, { escapeForHtml: false });
  return buildPrintHtml(parsed, subject);
}

export async function generateNoticePdf(fields: MergeFields, subjectLine: string): Promise<Buffer> {
  const html = buildNoticePrintHtml(fields, subjectLine);

  const executablePath = resolveChromeExecutablePath();
  // The production server runs this process as root (matches every other
  // app in this ecosystem's deploy setup), and Chrome refuses to launch as
  // root without this flag ("Running as root without --no-sandbox is not
  // supported", https://crbug.com/638180) — confirmed as the exact cause of
  // every "PDF generation failed unexpectedly" error since go-live. Safe
  // here specifically because this only ever renders our own
  // template-generated HTML (built from internal merge fields, never a
  // third-party URL or arbitrary user-supplied content), which is exactly
  // the case Chrome's own sandboxing guidance treats as acceptable to skip.
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdfUint8Array = await page.pdf({
      // @page rule above sets exact size/margins; printBackground stays
      // false (no shading in the original spec, borders only).
      preferCSSPageSize: true,
    });
    return Buffer.from(pdfUint8Array);
  } finally {
    await browser.close();
  }
}
