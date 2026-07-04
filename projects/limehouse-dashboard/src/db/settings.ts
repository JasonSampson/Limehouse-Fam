import bcrypt from "bcryptjs";
import { getPool } from "./pool.js";

// Data-access layer over dashboard_settings (Neo's migration 0001) — the
// single-row (id=1) shared password gate for the Team Performance tab. Per
// Neo's migration comment: team_performance_password_hash stays NULL until
// Jason sets a real password, and the tab must be treated as locked (no
// access) while it's NULL — that check lives in checkTeamPerformancePassword
// below, not just left to the caller to remember.
const BCRYPT_ROUNDS = 12;

export async function isTeamPerformancePasswordSet(): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT team_performance_password_hash FROM dashboard_settings WHERE id = 1`);
  return rows.length > 0 && rows[0].team_performance_password_hash !== null;
}

export async function setTeamPerformancePassword(plaintextPassword: string): Promise<void> {
  if (plaintextPassword.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const hash = await bcrypt.hash(plaintextPassword, BCRYPT_ROUNDS);
  const pool = getPool();
  await pool.query(`UPDATE dashboard_settings SET team_performance_password_hash = $1 WHERE id = 1`, [hash]);
}

// Returns false (never throws for a wrong password) whether the password is
// wrong OR simply not set yet — callers should not be able to distinguish
// "wrong password" from "no password configured" from the return value
// alone, since that would leak configuration state to anyone hitting the
// gate. isTeamPerformancePasswordSet() above is the explicit, separate way
// to check configuration state for admin-facing UI.
export async function checkTeamPerformancePassword(plaintextPassword: string): Promise<boolean> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT team_performance_password_hash FROM dashboard_settings WHERE id = 1`);
  const hash = rows[0]?.team_performance_password_hash;
  if (!hash) return false; // not set yet = locked, not a bypass
  return bcrypt.compare(plaintextPassword, hash);
}
