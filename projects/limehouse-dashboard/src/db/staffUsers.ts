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

export async function findByEmail(email: string): Promise<StaffUserRow | null> {
  const pool = getPool();
  const { rows } = await pool.query<RawRow>(`SELECT * FROM staff_users WHERE lower(email) = lower($1)`, [email]);
  return rows[0] ? toStaffUser(rows[0]) : null;
}

export async function inviteStaff(params: { email: string; role: "admin" | "staff" }): Promise<StaffUserRow> {
  const pool = getPool();
  const { rows } = await pool.query<RawRow>(
    `INSERT INTO staff_users (entra_object_id, email, role) VALUES (NULL, $1, $2) RETURNING *`,
    [params.email, params.role]
  );
  return toStaffUser(rows[0]);
}

export async function bumpLastLogin(id: number): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE staff_users SET last_login_at = now() WHERE id = $1`, [id]);
}

export async function listAll(): Promise<StaffUserRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<RawRow>(`SELECT * FROM staff_users ORDER BY created_at ASC`);
  return rows.map(toStaffUser);
}

export async function updateRole(id: number, role: "admin" | "staff"): Promise<StaffUserRow> {
  const pool = getPool();
  const { rows } = await pool.query<RawRow>(`UPDATE staff_users SET role = $2 WHERE id = $1 RETURNING *`, [id, role]);
  return toStaffUser(rows[0]);
}

export async function setActive(id: number, active: boolean): Promise<StaffUserRow> {
  const pool = getPool();
  const { rows } = await pool.query<RawRow>(`UPDATE staff_users SET active = $2 WHERE id = $1 RETURNING *`, [
    id,
    active,
  ]);
  return toStaffUser(rows[0]);
}
