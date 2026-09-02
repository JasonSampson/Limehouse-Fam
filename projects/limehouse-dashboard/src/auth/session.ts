import { SignJWT, jwtVerify } from "jose";
import type { Request, Response, NextFunction } from "express";
import { loadEnv } from "../config/env.js";

// The app's own short-lived session, issued after a successful Microsoft
// sign-in — replaces the old tp_unlocked shared-password cookie entirely.
// Same 8-hour lifetime late-rent-notices uses; kept for consistency and
// because it already matches Jason's "long enough for a workday, not
// indefinite" expectation from the old mechanism.
const SESSION_TTL_SECONDS = 60 * 60 * 8;

// `permissions` is the real, live list of dashboard.* keys LimeHQ granted
// this person at the moment they signed in — see src/api/authRoutes.ts's
// /auth/limehq-callback, which copies it straight out of the LimeHQ handoff
// token rather than looking anything up locally. There is no local "role"
// anymore: LimeHQ's Roles/Staff & Permissions pages are the one place access
// is set, and every gate in this app checks a specific key from this list
// instead of a single admin/staff bucket.
export interface StaffUser {
  id: number;
  permissions: string[];
}

function getSecretKey(): Uint8Array {
  const env = loadEnv();
  return new TextEncoder().encode(env.SESSION_COOKIE_SECRET);
}

async function createSessionToken(user: StaffUser): Promise<string> {
  return new SignJWT({ id: user.id, permissions: user.permissions })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

async function verifySessionToken(token: string): Promise<StaffUser> {
  const { payload } = await jwtVerify(token, getSecretKey());
  return {
    id: payload.id as number,
    permissions: Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [],
  };
}

export const SESSION_COOKIE_NAME = "lh_session";

function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: loadEnv().NODE_ENV === "production",
    sameSite: "strict" as const,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
  };
}

export async function issueSession(res: Response, user: StaffUser): Promise<void> {
  const token = await createSessionToken(user);
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME);
}

export interface AuthedRequest extends Request {
  user?: StaffUser;
}

// Verifies + decodes the session cookie without ending the response —
// callers that just need to know "who is this, if anyone" (e.g. page-gate
// middleware in server.ts) use this directly instead of requireLogin.
export async function getSessionUser(req: Request): Promise<StaffUser | null> {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) return null;
  try {
    return await verifySessionToken(token);
  } catch {
    return null;
  }
}

export async function requireLogin(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  req.user = user;
  next();
}

// Must run after requireLogin — relies on req.user already being set. Every
// section of the dashboard (Financials, Occupancy & Doors, Marketing &
// Showings, CEO View, Team Performance) is gated by its own specific
// dashboard.* permission key, checked here directly against the list LimeHQ
// granted at sign-in — see StaffUser above. Nobody is special-cased: the
// Owner sees every section only because getEffectivePermissions() on the
// LimeHQ side already returns every key for the Owner role, the same way it
// does for any fully-permissioned account.
export function requirePermission(key: string) {
  return function (req: AuthedRequest, res: Response, next: NextFunction): void {
    if (!req.user?.permissions.includes(key)) {
      res.status(403).json({ error: "You don't have permission to view this." });
      return;
    }
    next();
  };
}
