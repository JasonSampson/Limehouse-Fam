// The cover email that accompanies the 14-Day Notice PDF attachment.
// Distinct from the notice's own legal body text (initialLetterTemplate.ts)
// — the PDF is the actual legal document; this is a short, friendly cover
// note pointing the tenant at it, matching the standard email Limehouse
// used before this system existed (provided verbatim by Jason, 2026-08-05).
// Jason's reasoning: emailing the tenant the FULL legal notice text a
// second time, in the email body, on top of the identical PDF attachment,
// was redundant — a normal person doesn't need to read the same thing
// twice in one email.
//
// v1, per Jason 2026-08-05. Not stored in the DB (unlike letter_templates)
// — it carries no independent legal claims beyond restating the PDF's own
// 14-day deadline and attorney-referral consequence, both of which the
// attached PDF is still the authoritative, permanently-versioned source
// for. Changes to this file still go through the same Mason review any
// tenant-facing wording gets in this project.
//
// Merge fields: {{greeting}}, {{tenant_first_names}}, {{due_month_name}},
// {{payment_deadline}}. All four are computed in coverEmailFormatting.ts,
// not stored anywhere — recomputed fresh each time from the same
// notice_date/due_date/recipient data the PDF itself uses, so the two can
// never state a different deadline or month from one another.
export const COVER_EMAIL_KEY = "cover_email_v1";

export const COVER_EMAIL_GREETING_PARAGRAPH = `{{greeting}} {{tenant_first_names}},`;

export const COVER_EMAIL_BODY_MARKDOWN = `
Please see the attached letter regarding your past due rent for {{due_month_name}}. Payment is
due to our office via certified funds (cashier's check or money order) or via credit card online
within 14 days from the date of the letter. Payments not received by the end of the day on
{{payment_deadline}} will be turned over to the attorney for court filing as detailed in the
attached letter.

For payments to our office, our office address is below:

Please note our office address. The front door is located right up the concrete ramp on the back
side of the building. There is a drop slot on the side of that door, and you can drop the funds
right in the drop slot. Please advise status of payment upon receipt of this email.
`.trim();

// Static — never varies by notice, so it isn't run through merge-field
// substitution at all; spliced in as its own paragraph between the two
// dynamic ones above (see coverEmailFormatting.ts's renderCoverEmailHtml).
export const OFFICE_ADDRESS_LINES = ["Limehouse Property Management", "6056 Providence Road, Suite 200", "Virginia Beach, VA 23464"];
