import { SignJWT, jwtVerify } from "jose";
import type { Request, Response, NextFunction } from "express";
import { loadEnv } from "../config/env.js";

// The app's own short-lived session, issued after a successful Microsoft
// sign-in — replaces the old tp_unlocked shared-password cookie entirely.
// Same 8-hour lifetime late-rent-notices uses; kept for consistency and
// because it already matches Jason's "long enough for a workday, not
// indefinite" expectation from the old mechanism.
const SESSION_TTL_SECONDS = 60 * 60 * 8;

export interface StaffUser {
  id: number;
  role: "admin" | "staff";
}

function getSecretKey(): Uint8Array {
  const env = loadEnv();
  return new TextEncoder().encode(env.SESSION_COOKIE_SECRET);
}

async function createSessionToken(user: StaffUser): Promise<string> {
  return new SignJWT({ id: user.id, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

async function verifySessionToken(token: string): Promise<StaffUser> {
  const { payload } = await jwtVerify(token, getSecretKey());
  return { id: payload.id as number, role: payload.role as "admin" | "staff" };
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

// Must run after requireLogin — relies on req.user already being set.
export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  next();
}
