import { SignJWT, jwtVerify } from "jose";
import { loadEnv } from "../config/env.js";

const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8-hour absolute session cap
const IDLE_TIMEOUT_SECONDS = 60 * 30; // 30-minute inactivity timeout, checked in requireSession.ts
const PENDING_2FA_TTL_SECONDS = 60 * 5; // 5-minute window to complete TOTP setup/verification

// Nothing about role or permissions lives here — those are re-queried from
// the DB on every request (see requireSession.ts / permissions.ts), so a
// deactivation or role change takes effect on the user's very next request.
export interface SessionPayload {
  userId: number;
  email: string;
  authenticatedAt: number; // Unix timestamp in ms, stamped fresh on every login/re-auth — the anchor for the 8h absolute cap
  sessionVersion: number; // Snapshot of users.session_version at issue-time; requireSession.ts rejects a mismatch even though the JWT itself is still valid
  lastActivityAt: number; // Unix timestamp in ms, refreshed on every authenticated request; requireSession.ts logs the user out after 30 idle minutes
}

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(loadEnv().SESSION_COOKIE_SECRET);
}

// The JWT's own expiration is pinned to authenticatedAt + 8h (an absolute
// timestamp), NOT "now + 8h" relative to issuance. requireSession.ts
// re-issues this token on every request to refresh lastActivityAt (see
// sessionCookieOptions below), so a relative expiry would silently push the
// 8-hour cap forward on every click — defeating the "hard outer bound
// regardless of activity" requirement.
export async function createSessionToken(payload: SessionPayload): Promise<string> {
  const absoluteExpiry = Math.floor(payload.authenticatedAt / 1000) + SESSION_TTL_SECONDS;
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(absoluteExpiry)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, getSecretKey());
  return payload as unknown as SessionPayload;
}

export function isIdleExpired(lastActivityAt: number): boolean {
  return Date.now() - lastActivityAt > IDLE_TIMEOUT_SECONDS * 1000;
}

export const SESSION_COOKIE_NAME = "limehq_session";

// secure must be conditional on environment, not hardcoded true: a `secure`
// cookie is only ever stored by a browser over a real HTTPS connection.
// Production (https://limehq.net) is real HTTPS, so secure:true is correct
// there. Local dev runs on plain http://localhost:3300 — some browsers
// treat localhost as an implicit secure context and store the cookie
// anyway, but this is not guaranteed browser behavior (confirmed failing
// in a real Chrome instance 2026-08-01: every request after login silently
// had no session cookie, bouncing straight back to sign-in). The other
// three apps in this ecosystem (Dashboard, Late Rent Notices, Limona)
// already condition this correctly on NODE_ENV — this brings LimeHQ's own
// session cookie in line with that same pattern, which Sentinel's security
// review flagged as an inconsistency worth fixing.
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: loadEnv().NODE_ENV === "production",
    sameSite: "strict" as const,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
  };
}

// ------------------------------------------------------------------ //
// Pending-2FA token                                                   //
// ------------------------------------------------------------------ //
// Issued right after a password verifies, in place of a real session, when
// the login isn't done yet — either because TOTP setup hasn't been
// completed (users.totp_enabled_at IS NULL) or because setup is done and a
// code still needs to be entered. Deliberately minimal payload (just the
// user id) and a short TTL: this token proves "this browser just proved
// the password," nothing more — it must never be usable in place of a real
// session, and holding it is the ONLY way to reach POST /auth/totp or
// GET/POST /account/totp/setup (never a fresh email/password on those
// routes).

export interface Pending2faPayload {
  userId: number;
  purpose: "totp_pending";
}

export const PENDING_2FA_COOKIE_NAME = "limehq_pending2fa";

export async function createPending2faToken(userId: number): Promise<string> {
  const payload: Pending2faPayload = { userId, purpose: "totp_pending" };
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${PENDING_2FA_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifyPending2faToken(token: string): Promise<Pending2faPayload> {
  const { payload } = await jwtVerify(token, getSecretKey());
  if (payload["purpose"] !== "totp_pending") {
    throw new Error("Not a pending-2FA token");
  }
  return payload as unknown as Pending2faPayload;
}

export function pending2faCookieOptions() {
  return {
    httpOnly: true,
    secure: loadEnv().NODE_ENV === "production",
    sameSite: "strict" as const,
    maxAge: PENDING_2FA_TTL_SECONDS * 1000,
    path: "/",
  };
}
