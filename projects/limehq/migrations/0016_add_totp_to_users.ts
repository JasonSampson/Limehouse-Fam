import type { MigrationBuilder } from "node-pg-migrate";

// TOTP-based 2FA (authenticator app, e.g. Google Authenticator/Authy) —
// no backup/recovery codes by design (Jason rejected them: too much for
// staff to track). Owner-only recovery lives in a separate table, see
// migration 0017. Staff-side "lost my phone" reset needs no schema of its
// own — it's a plain UPDATE setting totp_secret/totp_enabled_at back to
// NULL plus bumping session_version, gated by the existing
// limehq.staff_management.edit permission (see src/staff/staffRoutes.ts).
//
// Collision check done before writing this migration: grepped the whole
// Limehouse-Fam workspace (LimeHQ, Dashboard, Late Rent Notices, Map — all
// share this Supabase instance's public schema) for `totp`, `owner_recovery`,
// and `session_version`. No existing hits anywhere. Clear to use these names.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("users", {
    // Ciphertext only (app-layer AES-256-GCM). The decryption key
    // (TOTP_ENCRYPTION_KEY) lives in the environment, never in this
    // database — a DB-only compromise cannot recover a usable secret.
    totp_secret: { type: "text" },
    // NULL = not enrolled / 2FA not enforced for this user yet.
    // Non-null = 2FA is active and required at login.
    totp_enabled_at: { type: "timestamptz" },
    // Separate from the existing failed_login_attempts (password) counter
    // on this table — a wrong TOTP code is a different failure mode from a
    // wrong password — but it feeds the SAME existing locked_until column
    // and lockout mechanism already in src/auth/authRoutes.ts (5 fails /
    // 15 min), not a second parallel lockout system.
    totp_failed_attempts: { type: "integer", notNull: true, default: 0 },
    // Bumped whenever this user's 2FA is force-reset (admin/staff reset, or
    // owner email-recovery via migration 0017's table). requireSession.ts
    // compares this live DB value against a version number stamped into the
    // session JWT at issue-time, so any cookie issued before the reset is
    // rejected even though it's still cryptographically valid and unexpired.
    //
    // NOTE FOR Q: this requires adding `sessionVersion: number` to
    // SessionPayload in src/auth/session.ts and stamping it at token-issue
    // time. session.ts is shared code other routes rely on (its header
    // comment already documents that role/permissions are deliberately kept
    // out of the JWT and re-queried live) — flagging this rather than
    // assuming, since it changes that interface's shape.
    session_version: { type: "integer", notNull: true, default: 1 },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("users", [
    "totp_secret",
    "totp_enabled_at",
    "totp_failed_attempts",
    "session_version",
  ]);
}
