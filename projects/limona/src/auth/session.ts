import crypto from "node:crypto";
import { loadEnv } from "../config/env.js";

// Simple session-based auth: a signed, opaque cookie carrying the LimeHQ user
// identity. Identity comes entirely from the LimeHQ handoff JWT — no local
// users table lookup on every request.
const SESSION_TTL_MS = 1000 * 60 * 60 * 8; // 8 hours

export interface SessionPayload {
  userId: string;   // LimeHQ integer userId stored as string
  email: string;
  issuedAt: number;
}

function getSecret(): string {
  return loadEnv().SESSION_COOKIE_SECRET;
}

function sign(value: string): string {
  return crypto.createHmac("sha256", getSecret()).update(value).digest("hex");
}

export function createSessionCookieValue(userId: string, email: string): string {
  const payload: SessionPayload = { userId, email, issuedAt: Date.now() };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(body);
  return `${body}.${signature}`;
}

// Returns the payload if the cookie is validly signed and not expired,
// otherwise null. Never throws — callers treat null as "not logged in".
export function verifySessionCookieValue(cookieValue: string | undefined): SessionPayload | null {
  if (!cookieValue) return null;
  const [body, signature] = cookieValue.split(".");
  if (!body || !signature) return null;

  const expectedSignature = sign(body);
  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.userId !== "string" || typeof payload.email !== "string" || typeof payload.issuedAt !== "number") return null;
    if (Date.now() - payload.issuedAt > SESSION_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_NAME = "limona_session";

export function sessionCookieOptions(env: ReturnType<typeof loadEnv>) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict" as const,
    maxAge: SESSION_TTL_MS,
    path: "/",
  };
}
