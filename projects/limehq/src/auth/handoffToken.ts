import { SignJWT, jwtVerify } from "jose";
import { loadEnv } from "../config/env.js";

// TODO: Add single-use enforcement (store consumed JTI in a DB table and
// reject replays) if the 60-second TTL alone is later deemed insufficient.

const HANDOFF_TTL_SECONDS = 60;

function getHandoffKey(): Uint8Array {
  return new TextEncoder().encode(loadEnv().HANDOFF_TOKEN_SECRET);
}

// `permissions` is scoped to whatever the target app actually needs — the
// /handoff route passes the caller's real dashboard.* keys for app=dashboard
// and an empty array for apps that don't consume per-permission access yet
// (late_rent_notices, limona), so a token never carries more than its
// destination app has any use for.
export async function createHandoffToken(
  userId: number,
  email: string,
  name: string,
  permissions: string[] = [],
): Promise<string> {
  return new SignJWT({ userId, email, name, permissions })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${HANDOFF_TTL_SECONDS}s`)
    .sign(getHandoffKey());
}

export async function verifyHandoffToken(
  token: string,
): Promise<{ userId: number; email: string; name: string; permissions: string[] }> {
  const { payload } = await jwtVerify(token, getHandoffKey());
  return {
    userId: payload.userId as number,
    email: payload.email as string,
    name: payload.name as string,
    permissions: Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [],
  };
}
