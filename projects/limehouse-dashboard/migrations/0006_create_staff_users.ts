import type { MigrationBuilder } from "node-pg-migrate";

// Real per-person staff accounts via Microsoft sign-in (Entra SSO), replacing
// the single shared Team Performance password (see
// 0007_drop_team_performance_password.ts for that removal).
//
// Named staff_users, not pm_users: this is a standalone database (see
// 0000_extensions_and_helpers.ts) with no relationship to late-rent-notices'
// pm_users table. Reusing the exact name "pm_users" across two separate
// projects/databases invites someone (a future dev, or Jason cross-checking
// notes) to assume they're the same table or need to stay in sync — they
// don't and won't. staff_users also reads correctly for this project's
// actual meaning: every row is a Limehouse staff member with dashboard
// access, not specifically a "property manager."
//
// Key difference from pm_users: this project needs an "invited but never
// logged in yet" state. Jason types in a work email and picks a role from a
// Manage Staff screen BEFORE that person's first Microsoft login — so
// entra_object_id must start NULL and gets filled in (permanently linked) the
// first time that email successfully signs in via Microsoft. pm_users never
// needed this because every row there was hand-inserted with the Entra id
// already known.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("staff_users", {
    id: "id",

    // Nullable on purpose: NULL means "invited, never logged in yet." Filled
    // in exactly once, on that account's first successful Microsoft login,
    // and never changed after that (a login is a match on email OR on
    // entra_object_id once set — app logic in src/db/, not this migration).
    entra_object_id: { type: "text" },

    // How Jason identifies someone before their first login, and how the
    // app matches a Microsoft login to a staff_users row when
    // entra_object_id is still NULL. Not nullable — always required, either
    // typed by Jason at invite time or (defensively) from the Microsoft
    // profile on first login.
    email: { type: "text", notNull: true },

    // Nullable until first login. Recommendation: do NOT make Jason type a
    // name when inviting someone — email + role is all Manage Staff needs to
    // collect, keeping that screen a two-field form. display_name is filled
    // in automatically from the Microsoft profile on first login, same as
    // pm_users' data source, just captured a step later here. Until then the
    // Manage Staff screen shows the email as the row's label.
    display_name: { type: "text" },

    // Matches late-rent-notices' pattern: text + CHECK, not an enum type.
    // Only two roles needed right now (Oracle's spec, Jason's "keep it
    // simple" standing instruction) — admin sees everything, staff sees
    // Dashboard only.
    role: { type: "text", notNull: true },

    // Offboarding switch. Inactive blocks login immediately regardless of
    // Microsoft 365 account status (per spec) — checked at login time in
    // addition to the entra_object_id/email lookup.
    active: { type: "boolean", notNull: true, default: true },

    // For the Manage Staff screen ("last seen" at a glance). NULL until
    // first login; updated on every successful login thereafter.
    last_login_at: { type: "timestamptz" },

    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("staff_users", "ck_staff_users_role", {
    check: "role IN ('admin','staff')",
  });

  // Case-insensitive uniqueness on email via a lowercase unique index, not a
  // citext column or app-level-only normalization:
  //   - citext would require pgm.createExtension("citext") for one column
  //     and a type this project doesn't use anywhere else.
  //   - App-level-only normalization (lowercasing in TypeScript before every
  //     query) is real but not enforced — a second code path (a script, a
  //     future migration, a manual psql fix) can still insert a case-variant
  //     duplicate and the database won't stop it.
  // A unique index on lower(email) enforces the invariant at the one place
  // that can't be bypassed, while keeping the column itself a plain text
  // column like everything else in this project. The app should still
  // lowercase email on write/lookup for consistent display and to avoid
  // relying on Postgres to catch mistakes.
  pgm.createIndex("staff_users", "lower(email)", {
    name: "uq_staff_users_email_lower",
    unique: true,
  });

  // entra_object_id is nullable (many rows will be NULL at once, for staff
  // who haven't logged in yet), so a plain unique index over the raw column
  // is correct: Postgres treats every NULL as distinct from every other
  // NULL, so multiple NULLs are allowed while any two non-NULL values must
  // still differ. Prevents the same Microsoft account from ever being linked
  // to two different staff_users rows.
  pgm.addConstraint("staff_users", "uq_staff_users_entra_object_id", {
    unique: ["entra_object_id"],
  });

  pgm.createTrigger("staff_users", "trg_set_updated_at_staff_users", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("staff_users", "trg_set_updated_at_staff_users");
  pgm.dropTable("staff_users");
}
