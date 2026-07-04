import type { MigrationBuilder } from "node-pg-migrate";

// Staff accounts. Two roles only per the approved spec: admin (Jason at
// launch) and member (everyone he invites). Invite-only — there is no
// signup flow, so every row starts life via either the bootstrap script
// (first admin) or an admin-issued invite.
//
// status is separate from role: disabling a user (status='disabled') is how
// admin revokes access without hard-deleting the row, so their chat history
// in chat_queries is preserved and FKs never dangle.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("users", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    email: { type: "text", notNull: true, unique: true },
    name: { type: "text", notNull: true },
    role: { type: "text", notNull: true },
    // Set when an admin creates the invite; cleared (used) once the staffer
    // redeems it and sets their own password. Unique so a token can only
    // ever map to exactly one pending invite.
    invite_token: { type: "text", unique: true },
    invite_token_used_at: { type: "timestamptz" },
    invited_by: { type: "uuid", references: "users" },
    // Null until the invite is redeemed — a user with status='invited' has
    // no usable password yet and cannot log in.
    password_hash: { type: "text" },
    status: { type: "text", notNull: true, default: "invited" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("users", "ck_users_role", {
    check: "role IN ('admin', 'member')",
  });
  pgm.addConstraint("users", "ck_users_status", {
    check: "status IN ('invited', 'active', 'disabled')",
  });

  pgm.createTrigger("users", "trg_set_updated_at_users", {
    when: "BEFORE",
    operation: "UPDATE",
    function: "set_updated_at",
    level: "ROW",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTrigger("users", "trg_set_updated_at_users");
  pgm.dropTable("users");
}
