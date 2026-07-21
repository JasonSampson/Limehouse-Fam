import type { MigrationBuilder } from "node-pg-migrate";

const areas = { schema: "map", name: "named_area_exclusions" };
const shadowMatches = { schema: "map", name: "named_area_exclusion_shadow_matches" };
const users = { schema: "public", name: "users" };

// The named-neighborhood exclusion tool — built by Jarvis directly, after
// Neo and Q both independently declined to build it on a claim relayed
// through the orchestrator rather than Jason's own direct word (see
// schema.md and governance-review.md for that history). Asimov's verdict:
// NOT APPROVED FOR ACTIVE, APPROVED TO BUILD IN SHADOW MODE ONLY, on five
// conditions — this migration exists to satisfy condition 1 ("schema/
// build proceeds now per Neo's design-path options, logging only") while
// structurally enforcing that nothing here can act for real yet.
//
// Matching mechanism: an admin-drawn boundary on the map (a polygon, a
// list of {lat,lng} vertices), not zip code — Jason directly: "Inside any
// one zip code could be 100 neighborhoods so I don't want to exclude
// anything solely by zip code." Matching a property's own geocoded
// location against a drawn boundary is a point-in-polygon check, done in
// application code (src/namedAreaExclusions/), not in SQL — no PostGIS
// dependency needed for this.
//
// CRITICAL invariant this schema exists to enforce: a `shadow`-status area
// must never be treated as a real exclusion by anything outside this
// module. There is deliberately no single "is this property excluded"
// view that blends property_exclusions with named_area_exclusions in this
// migration — that composition is for whatever eventually consumes it
// (the map UI, any future Buildium-side integration) to build explicitly
// against `status = 'active'` only, per computeAreaMatches.ts's own
// documentation. This migration's job is just to make `shadow` vs.
// `active` an explicit, auditable state with a real transition, not to
// pre-compose a convenience view that could get copy-pasted somewhere and
// quietly start including shadow-mode areas.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(areas, {
    id: "id",
    area_name: { type: "text", notNull: true },
    // JSONB array of {lat, lng} vertices forming the polygon an admin drew
    // on the map. Validated at the application layer (needs >= 3 points to
    // be a real polygon, needs each point to have numeric lat/lng in valid
    // ranges) — a CHECK constraint here would only catch "is this valid
    // JSON," not "is this a sane polygon," so that validation lives in
    // src/namedAreaExclusions/ instead.
    boundary: { type: "jsonb", notNull: true },
    status: { type: "text", notNull: true, default: "shadow" },
    created_by_user_id: { type: "bigint", notNull: true, references: users, onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    activated_by_user_id: { type: "bigint", references: users, onDelete: "RESTRICT" },
    activated_at: { type: "timestamptz" },
    retired_by_user_id: { type: "bigint", references: users, onDelete: "RESTRICT" },
    retired_at: { type: "timestamptz" },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(areas, "ck_named_area_exclusions_status", {
    check: `status IN ('shadow', 'active', 'retired')`,
  });

  // Every area starts in shadow and the activation fields stay NULL until
  // an explicit activation happens — this pair of constraints makes
  // "activated without an activator" or "activated_at set while still in
  // shadow" a data-integrity error, not just a convention someone could
  // forget to follow in application code.
  pgm.addConstraint(areas, "ck_named_area_exclusions_activation_consistency", {
    check: `
      (status = 'shadow' AND activated_by_user_id IS NULL AND activated_at IS NULL)
      OR
      (status IN ('active', 'retired') AND activated_by_user_id IS NOT NULL AND activated_at IS NOT NULL)
    `,
  });
  pgm.addConstraint(areas, "ck_named_area_exclusions_retirement_consistency", {
    check: `
      (status != 'retired' AND retired_by_user_id IS NULL AND retired_at IS NULL)
      OR
      (status = 'retired' AND retired_by_user_id IS NOT NULL AND retired_at IS NOT NULL)
    `,
  });

  pgm.createIndex(areas, "status");

  pgm.createTrigger(areas, "trg_set_updated_at_named_area_exclusions", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });

  // Shadow-mode log (Asimov condition 3 — Mason needs to review "the
  // actual shadow-mode exclusion log," not just confirm the mechanism
  // works). A live query alone ("which properties match right now") isn't
  // a log — it only shows the current instant. This table is a dated
  // snapshot, populated periodically (see shadowSnapshot.ts, wired into
  // the daily sync job) for every area still in `shadow` status, so
  // there's a real history to review across the 7+ day window, including
  // whether the matched set changed as new properties synced in.
  pgm.createTable(shadowMatches, {
    id: "id",
    named_area_exclusion_id: { type: "bigint", notNull: true, references: areas, onDelete: "CASCADE" },
    property_id: {
      type: "bigint",
      notNull: true,
      references: { schema: "map", name: "properties" },
      onDelete: "CASCADE",
    },
    matched_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex(shadowMatches, ["named_area_exclusion_id", "matched_at"]);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(shadowMatches);
  pgm.dropTable(areas);
}
