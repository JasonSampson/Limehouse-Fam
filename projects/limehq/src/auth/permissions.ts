import { getAppPool } from "../db/pool.js";
import { ApiError } from "../lib/apiError.js";

export interface UserWithRole {
  id: number;
  email: string;
  display_name: string;
  active: boolean;
  role_template_id: number;
  system_role_key: string | null;
  // Live value, compared against the JWT's stamped sessionVersion in
  // requireSession.ts — see migration 0016's comment on this column.
  session_version: number;
}

// Re-queried from DB on every authenticated request — never trusted from a
// session token — so deactivation and role changes take effect immediately.
export async function getUserWithRole(userId: number): Promise<UserWithRole | null> {
  const pool = getAppPool();
  const result = await pool.query<UserWithRole>(
    `SELECT u.id, u.email, u.display_name, u.active, u.role_template_id,
            u.session_version, rt.system_role_key
     FROM users u
     JOIN role_templates rt ON rt.id = u.role_template_id
     WHERE u.id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

// Permissions are two layers, merged:
//   1. Role baseline  — role_template_permissions (editable on the Roles page).
//   2. Personal override — user_permission_overrides (an exception for one
//      person, on top of their role's baseline). An override row's `granted`
//      value always wins for that user+key; if no override row exists, the
//      role's baseline decides. Overrides are tied to the user, not to a
//      specific role, so they survive a role change on that user.
// Owners always have all permissions regardless of rows.

interface UserRoleLookup {
  system_role_key: string | null;
  role_template_id: number;
}

async function getUserRoleLookup(userId: number): Promise<UserRoleLookup | null> {
  const pool = getAppPool();
  const userRow = await pool.query<UserRoleLookup>(
    `SELECT rt.system_role_key, u.role_template_id
     FROM users u JOIN role_templates rt ON rt.id = u.role_template_id
     WHERE u.id = $1`,
    [userId],
  );
  return userRow.rows[0] ?? null;
}

export interface PermissionBreakdown {
  // Keys granted by the user's current role baseline.
  roleGrantedKeys: Set<string>;
  // Personal override rows for this user: permission_key -> granted.
  overrides: Map<string, boolean>;
  // Final merged set: role baseline with overrides applied on top.
  effectiveKeys: Set<string>;
}

// Shared merge: role baseline + personal override, keyed by permission_key.
// A missing override row always falls through to the role's baseline —
// never treated as an implicit grant or an implicit revoke.
async function computePermissionBreakdown(
  userId: number,
  roleTemplateId: number,
): Promise<PermissionBreakdown> {
  const pool = getAppPool();

  const [roleGrants, overrides] = await Promise.all([
    pool.query<{ permission_key: string }>(
      `SELECT permission_key FROM role_template_permissions
       WHERE role_template_id = $1 AND granted = true`,
      [roleTemplateId],
    ),
    pool.query<{ permission_key: string; granted: boolean }>(
      `SELECT permission_key, granted FROM user_permission_overrides
       WHERE user_id = $1`,
      [userId],
    ),
  ]);

  const roleGrantedKeys = new Set(roleGrants.rows.map((r) => r.permission_key));
  const overrideMap = new Map(overrides.rows.map((o) => [o.permission_key, o.granted] as const));

  const effectiveKeys = new Set(roleGrantedKeys);
  for (const [key, granted] of overrideMap) {
    if (granted) {
      effectiveKeys.add(key);
    } else {
      effectiveKeys.delete(key);
    }
  }
  return { roleGrantedKeys, overrides: overrideMap, effectiveKeys };
}

// Exposed for the staff Permissions page, which needs to show — per
// permission key — whether the checked/unchecked state comes from the
// user's role or from a personal override that differs from it.
export async function getPermissionBreakdown(
  userId: number,
  roleTemplateId: number,
): Promise<PermissionBreakdown> {
  return computePermissionBreakdown(userId, roleTemplateId);
}

export async function hasPermission(userId: number, key: string): Promise<boolean> {
  const userRole = await getUserRoleLookup(userId);
  if (!userRole) return false;
  if (userRole.system_role_key === "owner") return true;

  const { effectiveKeys } = await computePermissionBreakdown(userId, userRole.role_template_id);
  return effectiveKeys.has(key);
}

// Full effective permission set for a user — used by GET /auth/me.
export async function getEffectivePermissions(userId: number): Promise<string[]> {
  const userRole = await getUserRoleLookup(userId);
  if (!userRole) return [];

  if (userRole.system_role_key === "owner") {
    const pool = getAppPool();
    const all = await pool.query<{ permission_key: string }>(
      `SELECT permission_key FROM permission_catalog ORDER BY sort_order`,
    );
    return all.rows.map((r) => r.permission_key);
  }

  const { effectiveKeys } = await computePermissionBreakdown(userId, userRole.role_template_id);
  return Array.from(effectiveKeys).sort();
}

// Any route that modifies or deletes a role_template must call this first.
// Throws a 403 ApiError if the target role carries system_role_key = 'owner'.
export function assertNotOwnerRole(systemRoleKey: string | null): void {
  if (systemRoleKey === "owner") {
    throw new ApiError(403, "The Owner role cannot be modified or deleted.");
  }
}
