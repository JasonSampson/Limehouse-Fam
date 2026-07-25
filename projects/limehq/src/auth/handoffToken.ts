import { SignJWT, jwtVerify } from "jose";
import { loadEnv } from "../config/env.js";

// TODO: Add single-use enforcement (store consumed JTI in a DB table and
// reject replays) if the 60-second TTL alone is later deemed insufficient.

const HANDOFF_TTL_SECONDS = 60;

function getHandoffKey(): Uint8Array {
  return new TextEncoder().encode(loadEnv().HANDOFF_TOKEN_SECRET);
}

export async function createHandoffToken(userId: number, email: string, name: string): Promise<string> {
  return new SignJWT({ userId, email, name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${HANDOFF_TTL_SECONDS}s`)
    .sign(getHandoffKey());
}

export async function verifyHandoffToken(
  token: string,
): Promise<{ userId: number; email: string; name: string }> {
  const { payload } = await jwtVerify(token, getHandoffKey());
  return { userId: payload.userId as number, email: payload.email as string, name: payload.name as string };
}
