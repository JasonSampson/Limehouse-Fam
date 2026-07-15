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

// Permissions are now fully per-person. Migration 0008 seeded
// user_permission_overrides for every existing user from their role template.
// New users start with no rows (no access) until explicitly granted on their
// permissions page. Owners always have all permissions regardless of rows.
export async function hasPermission(userId: number, key: string): Promise<boolean> {
  const pool = getAppPool();

  const userRow = await pool.query<{ system_role_key: string | null }>(
    `SELECT rt.system_role_key
     FROM users u JOIN role_templates rt ON rt.id = u.role_template_id
     WHERE u.id = $1`,
    [userId],
  );
  if (userRow.rows[0]?.system_role_key === "owner") return true;

  const result = await pool.query<{ granted: boolean }>(
    `SELECT granted FROM user_permission_overrides
     WHERE user_id = $1 AND permission_key = $2`,
    [userId, key],
  );
  return result.rows[0]?.granted ?? false;
}

// Full effective permission set for a user — used by GET /auth/me.
export async function getEffectivePermissions(userId: number): Promise<string[]> {
  const pool = getAppPool();

  const userRow = await pool.query<{ system_role_key: string | null }>(
    `SELECT rt.system_role_key
     FROM users u JOIN role_templates rt ON rt.id = u.role_template_id
     WHERE u.id = $1`,
    [userId],
  );
  if (userRow.rows[0]?.system_role_key === "owner") {
    const all = await pool.query<{ permission_key: string }>(
      `SELECT permission_key FROM permission_catalog ORDER BY sort_order`,
    );
    return all.rows.map((r) => r.permission_key);
  }

  const result = await pool.query<{ permission_key: string }>(
    `SELECT permission_key FROM user_permission_overrides
     WHERE user_id = $1 AND granted = true
     ORDER BY permission_key`,
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
