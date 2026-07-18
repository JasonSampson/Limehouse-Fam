import { getPool } from "./pool.js";

export interface StaffUserRow {
  id: number;
  email: string;
  displayName: string | null;
  role: "admin" | "staff";
  active: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface RawRow {
  id: number;
  email: string;
  display_name: string | null;
  role: "admin" | "staff";
  active: boolean;
  last_login_at: string | null;
  created_at: string;
}

function toStaffUser(row: RawRow): StaffUserRow {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    active: row.active,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

// Manage Staff (the invite/list/updateRole/setActive UI + its API routes)
// was REMOVED 2026-07-19, per Jason directly — staff accounts and access
// are now managed centrally in LimeHQ's own "Staff & Permissions" screen.
// findByEmail/bumpLastLogin stay: the dashboard's LimeHQ handoff callback
// (src/api/authRoutes.ts) still looks the signed-in person up in this
// local table to resolve their admin/staff role here. Known gap, accepted
// for now per Jason directly: a brand-new hire with LimeHQ access has no
// way to get a row in this table yet, since that used to be Manage
// Staff's job — to be addressed later (see the two options discussed:
// auto-provision on first login, or LimeHQ passing the role directly in
// the handoff token).
export async function findByEmail(email: string): Promise<StaffUserRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<RawRow>(`SELECT * FROM staff_users WHERE lower(email) = lower($1)`, [email]);
  return rows[0] ? toStaffUser(rows[0]) : null;
}

export async function bumpLastLogin(id: number): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE staff_users SET last_login_at = now() WHERE id = $1`, [id]);
}
