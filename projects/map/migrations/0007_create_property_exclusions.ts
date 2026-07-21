import type { MigrationBuilder } from "node-pg-migrate";

const table = { schema: "map", name: "property_exclusions" };
const properties = { schema: "map", name: "properties" };
const users = { schema: "public", name: "users" };

// "Do not pursue" flag — the four condition-based reason codes Asimov's
// governance-review.md marked "APPROVED TO BUILD" (per-property, never an
// area, condition/incident-based rather than location-based, matches
// Mason's original design in spec.md). No free-text reason, ever, and
// deliberately no catch-all 'other' bucket (unlike late-rent-notices'
// exclusions table) — the whole point of this closed list is no back door
// for a de facto free-text reason to hide inside "other".
//
// NOTE, deliberately NOT built in this migration: a fifth `staff_safety_
// concern` reason code (with incident_report/review_by columns). Neo's
// schema.md explicitly declined to design that reason code without Jason
// confirming directly, in his own words, that he wants it despite Mason's
// stated Fair Housing objection — a relayed "Jason confirmed" claim isn't
// the same thing, per Neo's and Asimov's own stated bar. Add it as its own
// follow-up migration (new CHECK constraint + two new nullable columns)
// once that direct confirmation exists somewhere Neo/Asimov can see it.
//
// "Who flagged it" is a real, verified identity — flagged_by_user_id /
// removed_by_user_id are foreign keys to LimeHQ's public.users(id), not a
// typed name. Map has no local user table; it is a LimeHQ-integrated
// module from day one (schema.md correction). Per-write authorization
// (only Owner/Admin roles may write here) is enforced at the application
// layer via LimeHQ's hasPermission(userId, 'map.exclusions.manage') check,
// not by Postgres — see schema.md's "Enforcing the Public/Internal Split"
// section.
//
// Operational note: this migration's FK to public.users(id) means Map's
// migrations must run against a database where LimeHQ's own migrations
// (0001-0009+, which create public.users) have already applied. That's
// true today in the shared qafzhvccodchweeebovd project, but matters for
// any fresh/CI database used to test Map in isolation.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable(table, {
    id: "id",
    property_id: { type: "bigint", notNull: true, references: properties, onDelete: "RESTRICT" },
    reason_code: { type: "text", notNull: true },
    flagged_by_user_id: { type: "bigint", notNull: true, references: users, onDelete: "RESTRICT" },
    flagged_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    active: { type: "boolean", notNull: true, default: true },
    removed_by_user_id: { type: "bigint", references: users, onDelete: "RESTRICT" },
    removed_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint(table, "ck_property_exclusions_reason_code", {
    check: `reason_code IN (
      'structure_condition',
      'never_renovated',
      'too_far_to_service',
      'past_operational_problems'
    )`,
  });

  // Hot path: "is this property currently flagged?" — same pattern as
  // late-rent-notices.exclusions.
  pgm.createIndex(table, "property_id", {
    name: "idx_property_exclusions_active",
    where: "active",
  });

  pgm.createTrigger(table, "trg_set_updated_at_property_exclusions", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable(table);
}
