import type { MigrationBuilder } from "node-pg-migrate";

// Owner-only 2FA recovery path (per Sentinel's reviewed design): if the
// Owner loses their authenticator device, they can request a one-time
// emailed token that resets their own TOTP enrollment without needing a
// second admin to do it for them (there is no one above Owner to ask).
// Staff members do NOT use this table — their reset path is an admin/Owner
// action gated by the existing limehq.staff_management.edit permission,
// needs no schema (see migration 0016's header comment).
//
// Deliberately not scoped to a single hardcoded user id: usage is gated at
// the application layer by checking the requesting user's role_templates
// row has system_role_key = 'owner' (see migration 0003), so this table
// stays structurally generic even though today there is exactly one Owner.
//
// token_hash, never plaintext: same reasoning as password_hash on users —
// a DB-only read of this table must not be enough to use the token. The
// emailed link carries the raw token; the app hashes it (SHA-256) before
// comparing against this column.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("owner_recovery_tokens", {
    id: "id",
    user_id: {
      type: "bigint",
      notNull: true,
      references: "users",
    },
    token_hash: { type: "text", notNull: true },
    // Issued as now() + 15 minutes by the application at request time.
    expires_at: { type: "timestamptz", notNull: true },
    // NULL = not yet redeemed. Set on successful use; a used token is
    // never valid again even if it hasn't expired yet.
    used_at: { type: "timestamptz" },
    // Best-effort context for the audit trail / anomaly review, not an
    // access control mechanism.
    requested_ip: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.createIndex("owner_recovery_tokens", "user_id", {
    name: "idx_owner_recovery_tokens_user_id",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("owner_recovery_tokens");
}
