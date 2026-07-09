// Version 3 of the 14-day notice of default. This text is built from
// Limehouse's own attorney-drafted "NOTICE OF DEFAULT - FAILURE TO PAY RENT"
// form (provided by Jason), not assembled from scratch — every substantive
// clause below (itemized charges, the Sec. 55.1-1251 damages-for-breach /
// attorney-turnover language, the credit-bureau notice, the Legal Aid
// Society contact line, the redemption-right/partial-payment paragraph, and
// the "accepted with reservation" certification line) is carried over from
// that source document.
//
// v3 change from v2: the Court Costs / Attorney's / Filing Fees / TOTAL Fees
// & Costs lines went from fixed placeholder text ("N/A — assessed upon
// referral to attorney") to real merge-field values (see below). This is a
// VALUE change, not a wording change — the blank-field wording itself was
// already part of the attorney's original approved document; letter_templates
// rows are immutable (migration 0008's trigger), so populating those blanks
// with real numbers requires a new version row, same as any other body_
// markdown edit, even though no legal text changed.
//
// Two, and only two, deviations from the attorney's verbatim text were
// approved by Jason:
//   1. Delivery method: the certification paragraph says "emailed... to the
//      address on file... pursuant to Lease Section 46" instead of "mailed
//      ... in accordance with Section 55.1-1202." Lease Section 46 ("...
//      electronic delivery of this Lease, addenda, or any notice/document
//      provided by landlord thereto through email or similar electronic
//      means shall constitute sufficient delivery...") is what Jason is
//      relying on to satisfy Virginia's electronic-notice requirement.
//   2. Payment method: the attorney's original restriction is kept in full
//      ("made directly to the Rental Office... Personal checks will not be
//      accepted"), with the Buildium tenant portal added as an ADDITIONAL
//      convenience alongside it — not a replacement, and no new exclusions
//      beyond the attorney's own (personal checks only) were added.
//
// Merge fields used: {{tenant_name}}, {{property_address}}, {{unit_label}},
// {{notice_date}}, {{due_date}}, {{days_late}}, {{amount_due}}, {{pm_name}},
// {{rent_amount_due}}, {{late_fee_amount_due}}, {{misc_amount_due}},
// {{court_costs_amount}}, {{attorney_fees_amount}},
// {{total_fees_and_costs_amount}}. All fields are defined on MergeFields
// (renderTemplate.ts) and populated by sendNotice.ts (and mirrored in
// noticeRoutes.ts's preview endpoint). The itemized rent/late-fee/misc-charge
// breakdown is backed by real classified Buildium charge data
// (notice_line_items, migration 0038; classifier in
// src/buildium/glClassification.ts) — see that change's report for the
// live-verification details (real GL account Type/SubType/Name values
// observed against Limehouse's actual chart of accounts).
//
// Court Costs / Attorney's / Filing Fees / TOTAL Fees & Costs are NO LONGER
// placeholder text. Per Jason's explicit instruction, these three lines now
// always render fixed, same-for-every-notice ESTIMATES (not ledger-derived,
// unlike the three fields above) — $91 court costs / $600 attorney's fees as
// of migrations 0040/0041, editable going forward by seeding a new config
// version (src/lib/config.ts getEstimatedCourtCosts/getEstimatedAttorneyFees).
// This applies on every notice, not just after a day-18 attorney referral —
// Jason confirmed this is the actual number his attorney-approved paper form
// already puts on every notice. The template WORDING of these three lines
// was already reviewed and approved as part of the attorney's original
// source document; only the values behind the blanks changed here, so this
// did not require a fresh Mason legal review.
//
// IMPORTANT: Mason has reviewed this exact source text and confirmed it
// resolves the Fair Housing / VRLTA concerns that existed with the prior
// (version 1) AI-drafted text. That legal sign-off is NOT the same thing as
// "ready to send real notices." Per GOVERNANCE.md, letter_templates.is_active
// must still stay false until the full deployment-readiness gate — TARS
// testing this rendered output end-to-end, then Judge's review — has passed.
// It is safe to load in shadow mode, where Send is a no-op.
export const INITIAL_TEMPLATE_KEY = "14_day_pay_or_quit";
export const INITIAL_TEMPLATE_VERSION = 4;

export const INITIAL_SUBJECT_LINE =
  "NOTICE OF DEFAULT — FAILURE TO PAY RENT — {{unit_label}}";

// v4 change from v3: the header block was restructured to match the actual
// table layout in the attorney's original document, which the earlier
// version got wrong. The original's header is a 3-row, 2-column table with
// the tenant's info on the left and Limehouse's name/address on the right,
// line for line (verified directly against the source .docx's raw XML —
// see generateNoticePdf.ts's parser for the corresponding table-building
// logic). v3 instead squashed TO and FROM onto one line and invented two
// labeled lines ("Property:" / "Date of Notice:") that do not exist
// anywhere in the original document. v4 fixes both: property_address and
// unit_label now fill the two blank lines under "TO:" (mirroring the two
// address lines under "FROM:" in the original), and the separate "Date of
// Notice:" line is removed — the date already appears in the body, both in
// the "TOTAL DUE LANDLORD AS OF {{notice_date}}" line and the certification
// paragraph, exactly as it does in the original (which has no standalone
// date line either). No substantive wording changed; Mason re-reviewed only
// the header restructuring, not the already-approved body clauses.
export const INITIAL_BODY_MARKDOWN = `
**NOTICE OF DEFAULT – FAILURE TO PAY RENT**

TO: {{tenant_name}}
{{property_address}}
{{unit_label}}
FROM: Limehouse Property Management
6056 Providence Rd, Suite 200
Virginia Beach, VA 23464

In accordance with 55.1-1245, Code of Virginia, you are hereby notified that
you are in default in the payment of rent, late charges and miscellaneous
charges as itemized below:

**ITEMIZED CHARGES:**

Rent for the Month(s) of {{due_date}}: {{rent_amount_due}}
Late Charges for Month(s) of {{due_date}}: {{late_fee_amount_due}}
Miscellaneous Charges: {{misc_amount_due}}
TOTAL DUE LANDLORD AS OF {{notice_date}} ({{days_late}} days past due): {{amount_due}}

If you fail to pay the total amount due within 14 days of this written
notice from the Landlord, the Landlord may terminate the rental agreement
and proceed to obtain possession of the premises as provided in 55.1-1251.
If your lease is terminated and you are evicted, Virginia Law (Section
55.1-1251) gives the Landlord a claim for damages for breach of the lease.
This claim may include rent for the entire balance of your lease term.
Additionally, your account will be turned over to our attorney for
immediate legal proceedings. In accordance with Section 55.1-1245 of the
Code of Virginia, you may then be liable for the following additional
court costs and attorney's fees:

Court Costs: {{court_costs_amount}}
Attorney's / Filing Fees: {{attorney_fees_amount}}
TOTAL Fees & Costs: {{total_fees_and_costs_amount}}

**YOU MAY AVOID PAYING ATTORNEY'S FEES AND COURT COSTS IF THE LANDLORD
RECEIVES THE TOTAL AMOUNT DUE WITHIN FOURTEEN (14) DAYS OF THIS NOTICE.
POSTMARKS WILL NOT BE CONSIDERED. ALL PAYMENTS SHOULD BE MADE DIRECTLY TO
THE RENTAL OFFICE. PERSONAL CHECKS WILL NOT BE ACCEPTED.** As a convenience,
payment may also be made online through the Buildium tenant portal.

Any partial payment of rent made before or after a judgment of possession
is ordered will not prevent your Landlord from taking action to evict you.
However, full payment of all amounts you owe the Landlord, including all
rent as contracted for in the rental agreement that is owed to the
Landlord as of the date payment is made, as well as any damages, money
judgment, award of attorney's fees, and court costs made at least 48 hours
before the scheduled eviction will cause the eviction to be canceled,
unless there are basis for the entry of an order of possession other than
nonpayment of rent stated in the unlawful detainer action filed by the
Landlord per 55.1-1250.

Judgements are immediately reported to the credit bureau. Act now to
protect your credit. Please direct your questions to the Rental Office.
You may also contact your local Legal Aid Society with any questions at
757-627-5423.

It is hereby certified that a true copy of the written Notice of Default
was emailed to the Tenant(s) named therein, addressed to said Tenant(s) at
the email address on file for the dwelling named therein, pursuant to
Lease Section 46, which provides that electronic delivery of any notice
constitutes sufficient delivery, all on {{notice_date}}.

**RESIDENT IS HEREBY NOTIFIED THAT ANY RENTAL PAYMENT RECEIVED IS WITH THE
UNDERSTANDING THAT PAYMENT WILL BE ACCEPTED RESERVING THE RIGHT TO SEEK
POSSESSION OF THE PREMISES IN GENERAL DISTRICT COURT.**

BY: {{pm_name}} (Authorized Agent)
Limehouse Property Management
`.trim();
