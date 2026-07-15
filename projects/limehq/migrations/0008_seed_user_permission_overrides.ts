import type { MigrationBuilder } from "node-pg-migrate";

// Converts the app from role-based permissions to per-person permissions.
// For every existing user, inserts one row in user_permission_overrides for
// each permission in the catalog — granted=true if their current role grants
// it, granted=false otherwise. After this runs, every user's access is driven
// entirely by their own rows; the role_template fallback in hasPermission() is
// no longer needed and will be removed from code.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    INSERT INTO user_permission_overrides (user_id, permission_key, granted)
    SELECT u.id, pc.permission_key, COALESCE(rtp.granted, false)
    FROM   users u
    CROSS  JOIN permission_catalog pc
    LEFT   JOIN role_template_permissions rtp
           ON  rtp.role_template_id = u.role_template_id
           AND rtp.permission_key   = pc.permission_key
    ON CONFLICT (user_id, permission_key) DO NOTHING;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM user_permission_overrides;`);
}
