import type { MigrationBuilder } from "node-pg-migrate";

// Staff accounts. LimeHQ is the system of record for authentication.
// Passwords are hashed by the application layer (bcryptjs) before storage —
// the raw password never touches this table.
// role_template_id is NOT NULL and NOT CASCADE: deleting a role that still
// has users assigned is a hard error, forcing a reassignment first.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("users", {
    id: "id",
    email: { type: "text", notNull: true },
    password_hash: { type: "text", notNull: true },
    display_name: { type: "text", notNull: true },
    role_template_id: {
      type: "bigint",
      notNull: true,
      references: "role_templates",
      onDelete: "RESTRICT",
    },
    active: { type: "boolean", notNull: true, default: true },
    last_login_at: { type: "timestamptz" },
    // Brute-force lockout tracking. Application increments on bad password,
    // resets to 0 on successful login.
    failed_login_attempts: { type: "integer", notNull: true, default: 0 },
    // NULL means not locked. Application sets this to now() + lockout window
    // when failed_login_attempts exceeds the threshold.
    locked_until: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("users", "uq_users_email", {
    unique: ["email"],
  });

  // Enforce lowercase at the DB level. The application layer must call
  // email.toLowerCase() before every INSERT and lookup.
  pgm.addConstraint("users", "ck_users_email_lowercase", {
    check: "email = lower(email)",
  });

  // Index for role queries (e.g. "who has this role assigned?").
  pgm.createIndex("users", "role_template_id", { name: "idx_users_role_template_id" });

  pgm.createTrigger("users", "trg_set_updated_at_users", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("users");
}
