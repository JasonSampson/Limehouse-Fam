// Version 1 of the 14-day pay-or-quit notice. Per the binding plan:
//   - Delivery is email-only (Jason's informed override of Mason's
//     ATTORNEY REQUIRED verdict, citing Lease Section 46). The
//     certification clause below says "emailed" — never "mailed" — because
//     "was mailed" is false regardless of the delivery-method decision.
//   - The ONLY two valid cure methods, stated explicitly: (a) credit card
//     via the Buildium tenant portal, or (b) certified funds dropped off
//     in person at the office. The old "Rental Office / no personal
//     checks" language is replaced entirely.
//   - Merge fields: {{tenant_name}}, {{unit_label}}, {{amount_due}},
//     {{days_late}}, {{due_date}}, {{property_address}}.
//
// IMPORTANT: this is a starting draft assembled from the plan's binding
// scope decisions, NOT a substitute for Mason's sign-off on final wording.
// Per GOVERNANCE.md, Mason must review this exact text (Fair Housing
// language + VRLTA compliance) before letter_templates version 1 is
// flipped to is_active = true in any environment that could send a real
// notice. It is safe to load in shadow mode, where Send is a no-op.
export const INITIAL_TEMPLATE_KEY = "14_day_pay_or_quit";
export const INITIAL_TEMPLATE_VERSION = 1;

export const INITIAL_SUBJECT_LINE =
  "NOTICE OF DEFAULT — 14-Day Notice to Pay Rent or Vacate — {{unit_label}}";

export const INITIAL_BODY_MARKDOWN = `
**NOTICE OF DEFAULT — 14-DAY NOTICE TO PAY RENT OR VACATE**

To: {{tenant_name}}
Property: {{property_address}}, {{unit_label}}
Date of Notice: {{notice_date}}

You are hereby notified that, as of {{notice_date}}, you are in default
under the terms of your lease for failure to pay rent when due. Your
account reflects an outstanding balance of **{{amount_due}}**, which became
due on {{due_date}} and is now **{{days_late}} days past due**.

Pursuant to Virginia Code §55.1-1245 and the terms of your lease, you are
hereby given fourteen (14) days from the date of this notice to pay the
full amount owed or vacate the premises. If the amount owed is not paid in
full within this 14-day period, the landlord may proceed to terminate your
tenancy and pursue all remedies available under Virginia law, including an
action for possession of the premises.

**How to cure this default.** Once a tenant's account is in default, there
are only two ways to pay the amount owed:

1. **Credit card payment through the Buildium tenant portal.**
2. **Certified funds (cashier's check or money order) dropped off in
   person at the property management office.**

No other payment method will be accepted to cure a default once a notice
of default has been issued. Personal checks, cash, and electronic transfers
outside the Buildium tenant portal are not accepted for curing a default.

**Certification of delivery.** This notice was emailed to the tenant(s) of
record on {{notice_date}} to the email address(es) on file with the
property manager, pursuant to Lease Section 46, which provides for
electronic delivery of notices under this lease.

This notice does not waive any rights or remedies available to the
landlord, including the right to recover rent owed, late fees, and any
other charges due under the lease.

Sincerely,
{{pm_name}}
Property Manager
Limehouse Property Management
`.trim();
