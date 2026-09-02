import { SignJWT } from "jose";
import request from "supertest";
import type { Express } from "express";
import { getTestPool } from "./testDb.js";

// Mints a token shaped exactly like the real LimeHQ handoff JWT: signed with
// the shared LIMEHQ_HANDOFF_SECRET, carrying { userId, email, permissions }.
// This is the same secret/payload shape src/routes/authRoutes.ts verifies at
// POST /auth/limehq-callback (see verifySessionCookieValue in
// src/auth/session.ts for what happens after).
async function mintHandoffToken(userId: string, email: string, permissions: string[]): Promise<string> {
  const secret = process.env.LIMEHQ_HANDOFF_SECRET;
  if (!secret) {
    throw new Error(
      "LIMEHQ_HANDOFF_SECRET is not set. DB integration tests require .env.test to define it " +
        "(same value the real .env.test uses for the LimeHQ handoff)."
    );
  }
  return new SignJWT({ userId, email, permissions })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

// CHANGED [today]: every LimeHQ-authenticated user used to be treated as
// admin in Limona (see src/auth/middleware.ts's history), so every existing
// call site here meant "log in as someone who can reach the admin routes."
// Defaulting `permissions` to the full limona.* set preserves that for every
// caller that doesn't care about the split; pass an explicit (possibly
// narrower or empty) list to test a specific permission's gate.
const FULL_LIMONA_PERMISSIONS = ["limona.chat.access", "limona.documents.manage", "limona.answers.contribute"];

export interface TestLimeHqUser {
  id: number;
  email: string;
  displayName?: string | null;
  permissions?: string[];
}

// Logs a supertest agent in through the REAL LimeHQ handoff flow (mint a
// signed token, POST it to /auth/limehq-callback, keep the session cookie
// the response sets) rather than bypassing auth in tests. This is the one
// shared place that mints handoff tokens for DB integration tests — every
// test file that needs an authenticated session should use this instead of
// re-implementing token minting (see feedback: don't duplicate
// security-sensitive logic).
//
// Also inserts/updates a row in the test-only "users" table stand-in (see
// truncateAllTables in test/support/testDb.ts) so admin routes that JOIN
// against LimeHQ's shared users table for a display name (e.g. reporting's
// asked_by) resolve to something real in tests, the same way they would
// against LimeHQ's actual table in production.
//
// Defaults to full admin-equivalent access (see FULL_LIMONA_PERMISSIONS
// above) unless the caller passes a narrower `permissions` list — the
// finer-grained limona.documents.manage/limona.answers.contribute split
// landed [today] (src/auth/middleware.ts's requirePermission).
export async function loginAsLimeHqUser(
  app: Express,
  user: TestLimeHqUser
): Promise<ReturnType<typeof request.agent>> {
  const pool = getTestPool();
  await pool.query(
    `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name`,
    [user.id, user.email, user.displayName ?? null]
  );

  const token = await mintHandoffToken(String(user.id), user.email, user.permissions ?? FULL_LIMONA_PERMISSIONS);
  const agent = request.agent(app);
  await agent.post("/auth/limehq-callback").send({ token });
  return agent;
}
