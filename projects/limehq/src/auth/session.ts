import { SignJWT, jwtVerify } from "jose";
import { loadEnv } from "../config/env.js";

const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8-hour session

// Nothing about role or permissions lives here — those are re-queried from
// the DB on every request (see requireSession.ts / permissions.ts), so a
// deactivation or role change takes effect on the user's very next request.
export interface SessionPayload {
  userId: number;
  email: string;
  authenticatedAt: number; // Unix timestamp in ms, stamped fresh on every login/re-auth
}

function getSecretKey(): Uint8Array {
  return new TextEncoder().encode(loadEnv().SESSION_COOKIE_SECRET);
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

export const SESSION_COOKIE_NAME = "limehq_session";

export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  maxAge: SESSION_TTL_SECONDS * 1000,
  path: "/",
};
