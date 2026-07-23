import { SignJWT } from "jose";
import request from "supertest";
import type { Express } from "express";
import { getTestPool } from "./testDb.js";

// Mints a token shaped exactly like the real LimeHQ handoff JWT: signed with
// the shared LIMEHQ_HANDOFF_SECRET, carrying { userId, email }. This is the
// same secret/payload shape src/routes/authRoutes.ts verifies at
// POST /auth/limehq-callback (see verifySessionCookieValue in
// src/auth/session.ts for what happens after).
async function mintHandoffToken(userId: string, email: string): Promise<string> {
  const secret = process.env.LIMEHQ_HANDOFF_SECRET;
  if (!secret) {
    throw new Error(
      "LIMEHQ_HANDOFF_SECRET is not set. DB integration tests require .env.test to define it " +
        "(same value the real .env.test uses for the LimeHQ handoff)."
    );
  }
  return new SignJWT({ userId, email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

export interface TestLimeHqUser {
  id: number;
  email: string;
  displayName?: string | null;
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
// Every LimeHQ-authenticated user is treated as admin in Limona today (see
// src/auth/middleware.ts) — Jason is handling the finer-grained permission
// split on the LimeHQ side separately — so this is the only kind of login
// DB integration tests need right now.
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

  const token = await mintHandoffToken(String(user.id), user.email);
  const agent = request.agent(app);
  await agent.post("/auth/limehq-callback").send({ token });
  return agent;
}
