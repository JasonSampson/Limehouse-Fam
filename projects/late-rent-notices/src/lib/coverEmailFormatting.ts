import { getEasternLocalHourMinute } from "./scheduler.js";
import { renderTemplate, formatTenantNameList } from "../templates/renderTemplate.js";
import { escapeHtml, groupLinesIntoParagraphs, paragraphsToHtml } from "./noticeBodyFormatting.js";
import {
  COVER_EMAIL_GREETING_PARAGRAPH,
  COVER_EMAIL_BODY_MARKDOWN,
  OFFICE_ADDRESS_LINES,
  CLOSING_SIGNATURE_LEAD,
  CLOSING_SIGNATURE_TRAILING_LINES,
} from "../templates/coverEmailTemplate.js";

// Good morning / afternoon / evening by the REAL Virginia local clock at
// send time, per Jason (2026-08-05) — reuses scheduler.ts's own Eastern-
// time reader (same DST-aware Intl approach already relied on for the
// daily job's run time) rather than a fixed UTC offset, which would drift
// by the DST amount and eventually greet someone at the wrong time of day
// entirely. Boundaries: before noon is morning, noon–5pm is afternoon
// (5pm matches businessCalendar.ts's own end-of-office-hours cutoff),
// 5pm and later is evening.
export function getTimeOfDayGreeting(sentAt: Date): string {
  const { hour } = getEasternLocalHourMinute(sentAt);
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

const ORDINAL_MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

// "August 17th" — casual style for the cover email, distinct from the
// legal notice's formal MM/DD/YYYY (formatDateMMDDYYYY). Uses UTC parts,
// matching every other date in this app (formatDateMMDDYYYY, the due-date
// math in lateness.ts) — calendar-day arithmetic is done consistently in
// UTC terms throughout, so this deadline can never silently disagree by a
// day with the "14 days" the legal notice itself states.
export function formatOrdinalDate(date: Date): string {
  const month = ORDINAL_MONTH_NAMES[date.getUTCMonth()];
  const day = date.getUTCDate();
  return `${month} ${day}${ordinalSuffix(day)}`;
}

// Month name only ("August") — the month rent is past due for. Per Jason:
// this is always just the CURRENT month in practice, since a second unpaid
// month would mean eviction was already filed before a new notice could
// go out — matches calculateLateness's own model, which only ever tracks
// one open due date at a time (never multiple simultaneously-unpaid
// months), so due_date's month is always the right answer here.
export function formatDueMonthName(dueDate: Date): string {
  return ORDINAL_MONTH_NAMES[dueDate.getUTCMonth()];
}

// 14 days after the notice is sent, per Va. Code § 55.1-1245's "within 14
// days AFTER written notice is served" and § 1-210's general rule for
// counting days in Virginia law: the day of the triggering event itself
// is excluded, counting starts the next day. Jason confirmed this on
// 2026-08-05 after checking — the company's prior standard email had this
// wrong for an unknown length of time, treating the send day as day one
// instead of day zero. Sent Aug 4: Aug 4 doesn't count, Aug 5 is day 1,
// Aug 18 is day 14 — not Aug 17. Matches escalationCheck.ts's own
// `sent_at + INTERVAL '14 days'`, which was already correct (a plain
// 14-day addition to the original timestamp inherently treats that
// original moment as day zero) — this function just needed to match it.
// Same UTC calendar-day arithmetic as everywhere else in this app.
export function computePaymentDeadline(noticeDate: Date): Date {
  const deadline = new Date(noticeDate);
  deadline.setUTCDate(deadline.getUTCDate() + 14);
  return deadline;
}

// "Corinne and Ladereck" — first names only, for the email's casual
// greeting (the legal notice/PDF still uses full legal names throughout;
// this is purely a friendlier greeting line). Reuses
// formatTenantNameList's own "A and B" / "A, B, and C" joining so the two
// never drift into different conventions for 3+ tenants.
export function formatTenantFirstNames(fullNames: string[]): string {
  const firstNames = fullNames.map((name) => name.trim().split(/\s+/)[0] ?? name);
  return formatTenantNameList(firstNames);
}

export interface CoverEmailMergeFields {
  greeting: string;
  tenant_first_names: string;
  due_month_name: string;
  payment_deadline: string;
  // The same person who signs the PDF's own "BY: {name}" line — see each
  // call site's mergeFields.pm_name, computed once and reused for both.
  sender_name: string;
}

// Renders the full cover email body — the greeting, the payment/deadline
// paragraph, the static office-address block, the closing paragraph, and
// (v2) a closing signature block. The address block and signature block
// are both spliced in as their own untouched <p> elements rather than
// being part of COVER_EMAIL_BODY_MARKDOWN's merge-field substitution pass
// — the address never varies at all, and the signature's only variable
// part (the sender's name) still needs HTML-escaping but not the
// paragraph-reflow/bold-markdown machinery that pass is for.
export function renderCoverEmailHtml(fields: CoverEmailMergeFields): string {
  const greetingHtml = paragraphsToHtml([renderTemplate(COVER_EMAIL_GREETING_PARAGRAPH, fields, { escapeForHtml: false })]);

  const bodyParagraphs = groupLinesIntoParagraphs(COVER_EMAIL_BODY_MARKDOWN.split("\n")).map((p) =>
    renderTemplate(p, fields, { escapeForHtml: false })
  );
  // Exactly 2 paragraphs precede the address block in
  // COVER_EMAIL_BODY_MARKDOWN (payment/deadline, then "address is
  // below:") — spliced after index 1, same fail-loudly principle as
  // generateNoticePdf.ts's line-count assertions: if a future edit to
  // the template changes that shape, this should be caught by review,
  // not silently misplace the address block.
  if (bodyParagraphs.length !== 3) {
    throw new Error(
      `renderCoverEmailHtml: expected exactly 3 paragraphs in COVER_EMAIL_BODY_MARKDOWN, found ${bodyParagraphs.length}`
    );
  }
  const addressHtml = `<p>${OFFICE_ADDRESS_LINES.map(escapeHtml).join("<br>")}</p>`;
  const signatureHtml = `<p>${[CLOSING_SIGNATURE_LEAD, fields.sender_name, ...CLOSING_SIGNATURE_TRAILING_LINES].map(escapeHtml).join("<br>")}</p>`;

  return [
    greetingHtml,
    paragraphsToHtml([bodyParagraphs[0], bodyParagraphs[1]]),
    addressHtml,
    paragraphsToHtml([bodyParagraphs[2]]),
    signatureHtml,
  ].join("\n");
}
