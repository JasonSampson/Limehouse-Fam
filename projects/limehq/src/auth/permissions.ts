import { getAppPool } from "../db/pool.js";
import { ApiError } from "../lib/apiError.js";

export interface UserWithRole {
  id: number;
  email: string;
  display_name: string;
  active: boolean;
  role_template_id: number;
  system_role_key: string | null;
}

// Re-queried from DB on every authenticated request — never trusted from a
// session token — so deactivation and role changes take effect immediately.
export async function getUserWithRole(userId: number): Promise<UserWithRole | null> {
  const pool = getAppPool();
  const result = await pool.query<UserWithRole>(
    `SELECT u.id, u.email, u.display_name, u.active, u.role_template_id,
            rt.system_role_key
     FROM users u
     JOIN role_templates rt ON rt.id = u.role_template_id
     WHERE u.id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

// Resolution order (re-queried from DB on every call):
// 1. user_permission_overrides for (userId, key) — if a row exists, its
//    granted value wins regardless of the role.
// 2. role_template_permissions for the user's assigned role — present +
//    granted = true, absent = false (default-deny).
export async function hasPermission(userId: number, key: string): Promise<boolean> {
  const pool = getAppPool();

  const override = await pool.query<{ granted: boolean }>(
    `SELECT granted
     FROM user_permission_overrides
     WHERE user_id = $1 AND permission_key = $2`,
    [userId, key],
  );
  if (override.rows.length > 0) {
    return override.rows[0].granted;
  }

  const roleGrant = await pool.query<{ granted: boolean }>(
    `SELECT rtp.granted
     FROM role_template_permissions rtp
     JOIN users u ON u.role_template_id = rtp.role_template_id
     WHERE u.id = $1 AND rtp.permission_key = $2`,
    [userId, key],
  );
  if (roleGrant.rows.length > 0) {
    return roleGrant.rows[0].granted;
  }

  return false; // default-deny
}

// Used by GET /auth/me. Fetches the full effective permission set in one
// query instead of calling hasPermission() per key, which would be N+1.
// Logic: override wins if present, otherwise role grant, otherwise false.
export async function getEffectivePermissions(userId: number): Promise<string[]> {
  const pool = getAppPool();
  const result = await pool.query<{ permission_key: string }>(
    `SELECT pc.permission_key
     FROM permission_catalog pc
     LEFT JOIN user_permission_overrides upo
       ON upo.user_id = $1 AND upo.permission_key = pc.permission_key
     LEFT JOIN role_template_permissions rtp
       ON rtp.permission_key = pc.permission_key
      AND rtp.role_template_id = (SELECT role_template_id FROM users WHERE id = $1)
     WHERE COALESCE(upo.granted, rtp.granted, false) = true
     ORDER BY pc.sort_order`,
    [userId],
  );
  return result.rows.map((r) => r.permission_key);
}

// Any route that modifies or deletes a role_template must call this first.
// Throws a 403 ApiError if the target role carries system_role_key = 'owner'.
export function assertNotOwnerRole(systemRoleKey: string | null): void {
  if (systemRoleKey === "owner") {
    throw new ApiError(403, "The Owner role cannot be modified or deleted.");
  }
}
