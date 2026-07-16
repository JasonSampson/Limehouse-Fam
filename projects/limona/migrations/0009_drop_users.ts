import type { MigrationBuilder } from "node-pg-migrate";

// Removes Limona's local users table. Authentication is now handled entirely
// by LimeHQ — staff log in once through LimeHQ and are handed off to Limona
// via a signed short-lived JWT. No local password or invite flow is needed.
//
// Steps:
// 1. Drop the FK from chat_queries.user_id → users (stored UUIDs become orphans)
// 2. Change chat_queries.user_id from UUID to text so it can hold LimeHQ's
//    integer user IDs going forward (cast existing UUIDs to text to preserve history)
// 3. Drop the users table (CASCADE drops the invited_by self-FK automatically)
//
// NOTE: Existing chat_query rows keep their old Limona UUID as user_id text —
// that's fine for history/audit purposes; they just won't match any LimeHQ ID.
// New rows will store the LimeHQ userId integer as a text string.
//
// This migration CANNOT be automatically reversed (the user data is gone).
// To roll back you would need to restore from a backup.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // 1. Drop the FK constraint (PostgreSQL default name for the FK on user_id).
  pgm.dropConstraint("chat_queries", "chat_queries_user_id_fkey");

  // 2. Change user_id column type from uuid to text (cast existing values).
  pgm.alterColumn("chat_queries", "user_id", {
    type: "text",
    using: "user_id::text",
  });

  // 3. Drop the users table — CASCADE removes the invited_by self-FK.
  pgm.sql("DROP TABLE IF EXISTS users CASCADE");
}

export async function down(_pgm: MigrationBuilder): Promise<void> {
  // Cannot reverse automatically — restoring the users table would require
  // a data backup. This is intentional; the down migration is a no-op.
  throw new Error(
    "Migration 0009 cannot be rolled back automatically. Restore the users table from a backup if needed."
  );
}
