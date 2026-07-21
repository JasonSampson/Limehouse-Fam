import type { MigrationBuilder } from "node-pg-migrate";

const table = { schema: "map", name: "property_exclusions" };

// Adds the fifth `property_exclusions` reason code: `staff_safety_concern`.
//
// Built by Jarvis directly (not Neo/Q), after both independently declined
// to build this on a claim relayed through the orchestrator rather than
// Jason's own direct word — see schema.md's "Named-Neighborhood Exclusion
// Tool" section and governance-review.md's condition 5 for that history.
// Jarvis has first-hand knowledge of the live conversation in which Jason
// confirmed this directly, and is executing it directly for that reason
// (see the project's "Production execution routing" convention: live
// execution stays with the orchestrator rather than being delegated to a
// subagent that cannot itself verify relayed authorization).
//
// Asimov's governance-review.md verdict: "staff_safety_concern reason
// code: APPROVED TO BUILD, with two non-blocking follow-ups" — (1) define
// an evidence floor for "documented incident" so it can't quietly become
// free text with extra steps, (2) default the review-date mechanism to
// auto-expire (fail toward NOT excluding) rather than stay active by
// inertia. A third, Asimov's "cheap insurance": a standing query surfacing
// geographic clustering of these flags specifically, since this is the
// one reason code that could let the disputed area-exclusion pattern
// re-emerge one property at a time without anyone intending it.
//
// Scoping, unchanged from Mason's original review: property-specific
// (never an area), tied to one documented incident, reviewable on a set
// date. Access is Owner + Admin via LimeHQ's existing
// `map.exclusions.manage` permission — Asimov's review did not call for a
// narrower permission than that for this specific reason code.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn(table, {
    // Evidence floor (Asimov condition 1): must reference an
    // already-existing, dated record — not written fresh at flagging
    // time. Postgres can't verify the *content* is a real reference, but
    // the length floor plus the documented convention (enforced again at
    // the UI layer when Tron builds the flagging form) keeps this from
    // silently becoming a free-text box with extra steps. Convention:
    // must name a source and a date, e.g. "Property Meld ticket #1234,
    // 2026-06-01" or "email from [name], 2026-06-01" — never a bare
    // description of the incident with no reference.
    incident_report: { type: "text" },
    // Auto-expire (Asimov condition 2): the date this flag must be
    // reviewed by. NULL is not "never expires" for this reason code —
    // see the CHECK constraint below, which requires this to be set
    // whenever reason_code = 'staff_safety_concern'. Whether a given flag
    // still counts as active "right now" is a computed condition (see
    // the view below), not a boolean this column flips — so there's no
    // separate stale-boolean-vs-real-date drift to worry about.
    review_by: { type: "date" },
  });

  pgm.dropConstraint(table, "ck_property_exclusions_reason_code");
  pgm.addConstraint(table, "ck_property_exclusions_reason_code", {
    check: `reason_code IN (
      'structure_condition',
      'never_renovated',
      'too_far_to_service',
      'past_operational_problems',
      'staff_safety_concern'
    )`,
  });

  // Ties incident_report/review_by presence to the reason code: both
  // required (and incident_report non-trivial in length, per the evidence
  // floor above) for staff_safety_concern, both forbidden (NULL) for every
  // other reason code — so this can never become a general-purpose
  // free-text field available to the other four, condition-based reasons.
  pgm.addConstraint(table, "ck_property_exclusions_safety_concern_fields", {
    check: `
      (reason_code = 'staff_safety_concern'
        AND incident_report IS NOT NULL
        AND char_length(trim(incident_report)) >= 20
        AND review_by IS NOT NULL)
      OR
      (reason_code != 'staff_safety_concern'
        AND incident_report IS NULL
        AND review_by IS NULL)
    `,
  });

  // "Currently excluded" is a computed view, not a change to what `active`
  // means — `active` stays a plain audit-trail toggle (did staff turn this
  // on/off), and this view is the one place that also accounts for
  // auto-expiry. Anything that needs to know "does this property currently
  // count as do-not-pursue" should query this view, not the raw table,
  // exactly the same "compute it, don't hand-maintain a second flag"
  // philosophy already used elsewhere in this schema (e.g. leases'
  // "current lease" being a query over lease_status, not its own column).
  pgm.createView(
    { schema: "map", name: "property_exclusions_effective" },
    {},
    `
    SELECT *
    FROM map.property_exclusions
    WHERE active
      AND (review_by IS NULL OR review_by >= CURRENT_DATE)
    `
  );

  // Asimov condition 3: a standing (not scheduled/automated this pass —
  // that's a small follow-up, not a blocker) query surfacing the
  // geographic distribution of active staff_safety_concern flags, for
  // Jason/Mason to eyeball periodically (quarterly is fine per Asimov).
  // Run with: SELECT * FROM map.staff_safety_concern_geographic_distribution;
  pgm.createView(
    { schema: "map", name: "staff_safety_concern_geographic_distribution" },
    {},
    `
    SELECT p.city, p.postal_code, count(*) AS active_flag_count
    FROM map.property_exclusions_effective pe
    JOIN map.properties p ON p.id = pe.property_id
    WHERE pe.reason_code = 'staff_safety_concern'
    GROUP BY p.city, p.postal_code
    ORDER BY active_flag_count DESC
    `
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropView({ schema: "map", name: "staff_safety_concern_geographic_distribution" });
  pgm.dropView({ schema: "map", name: "property_exclusions_effective" });
  pgm.dropConstraint(table, "ck_property_exclusions_safety_concern_fields");
  pgm.dropConstraint(table, "ck_property_exclusions_reason_code");
  pgm.addConstraint(table, "ck_property_exclusions_reason_code", {
    check: `reason_code IN (
      'structure_condition',
      'never_renovated',
      'too_far_to_service',
      'past_operational_problems'
    )`,
  });
  pgm.dropColumn(table, "review_by");
  pgm.dropColumn(table, "incident_report");
}
