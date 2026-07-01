import { SignJWT, jwtVerify } from "jose";
import { loadEnv } from "../config/env.js";

// The app's OWN short-lived session — never passes the raw Entra ID token
// around after login. httpOnly/secure/sameSite=strict cookie, per
// Sentinel's requirement.
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8-hour session, re-auth required for fallback actions regardless.

export interface SessionPayload {
  pmUserId: number;
  email: string;
  isFallbackDecisionMaker: boolean;
  // Stamped fresh on every login. The fallback-send path checks this is
  // recent (see requireFreshReauth.ts) rather than trusting session age
  // alone, since a long-lived session could otherwise be reused.
  authenticatedAt: number;
}

function getSecretKey(): Uint8Array {
  const env = loadEnv();
  return new TextEncoder().encode(env.SESSION_COOKIE_SECRET);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

export async function verifySessionToken(token: string): Promise<SessionPayload> {
  const { payload } = await jwtVerify(token, getSecretKey());
  return payload as unknown as SessionPayload;
}

export const SESSION_COOKIE_NAME = "lrn_session";

export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  maxAge: SESSION_TTL_SECONDS * 1000,
  path: "/",
};
