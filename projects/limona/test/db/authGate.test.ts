import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { closeTestPool } from "../support/testDb.js";

process.env.SESSION_COOKIE_SECRET ||= "test-secret-at-least-32-characters-long";

const { buildTestApp } = await import("../support/testApp.js");

// Carried over from the old invite/password auth.test.ts (deleted once Limona's
// local users table + /api/auth/login were removed in favor of the LimeHQ
// handoff login). The invite/password-specific cases in that file no longer
// apply, but this one generic check — chatRoutes' requireAuth gate rejects an
// unauthenticated request — wasn't duplicated in any other test file, so it's
// preserved here. (The equivalent check for admin routes IS already covered
// per-router in adminDashboard.test.ts, assets.test.ts, reporting.test.ts, and
// teamKnowledge.test.ts, so it isn't repeated here.)
describe("chatRoutes auth gate", () => {
  const app = buildTestApp();

  afterAll(async () => {
    await closeTestPool();
  });

  it("blocks an unauthenticated request to a chat route", async () => {
    const res = await request(app).post("/api/chat/ask").send({ question: "hello" });
    expect(res.status).toBe(401);
  });
});
