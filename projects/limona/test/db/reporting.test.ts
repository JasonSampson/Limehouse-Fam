import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { getTestPool, truncateAllTables, closeTestPool } from "../support/testDb.js";
import { loginAsLimeHqUser } from "../support/testAuth.js";

process.env.SESSION_COOKIE_SECRET ||= "test-secret-at-least-32-characters-long";

const { buildTestApp } = await import("../support/testApp.js");

describe("admin reporting routes", () => {
  const pool = getTestPool();
  const app = buildTestApp();

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("blocks an unauthenticated request", async () => {
    const res = await request(app).get("/api/admin/reporting/recent-questions");
    expect(res.status).toBe(401);
  });

  it("lists recent questions most-recent-first with answered flag and asker name", async () => {
    const agent = await loginAsLimeHqUser(app, { id: 1, email: "admin@limehousepm.com", displayName: "Admin Person" });
    const adminId = "1";

    await pool.query(
      `INSERT INTO chat_queries (user_id, question, answered, created_at) VALUES
       ($1, 'first question', true, now() - interval '2 hours'),
       ($1, 'second question', false, now() - interval '1 hour'),
       ($1, 'third question', true, now())`,
      [adminId]
    );

    const res = await agent.get("/api/admin/reporting/recent-questions");
    expect(res.status).toBe(200);
    expect(res.body.questions).toHaveLength(3);
    expect(res.body.questions.map((q: { question: string }) => q.question)).toEqual([
      "third question",
      "second question",
      "first question",
    ]);
    expect(res.body.questions[0].answered).toBe(true);
    expect(res.body.questions[0].asked_by).toBe("Admin Person");
  });

  it("falls back to email when the asker has no display name set", async () => {
    const agent = await loginAsLimeHqUser(app, { id: 2, email: "no-display-name@limehousepm.com", displayName: null });

    await pool.query(`INSERT INTO chat_queries (user_id, question, answered) VALUES ('2', 'a question', true)`);

    const res = await agent.get("/api/admin/reporting/recent-questions");
    expect(res.status).toBe(200);
    expect(res.body.questions[0].asked_by).toBe("no-display-name@limehousepm.com");
  });

  it("only surfaces answered=false questions as knowledge gaps", async () => {
    const agent = await loginAsLimeHqUser(app, { id: 1, email: "admin@limehousepm.com", displayName: "Admin Person" });

    await pool.query(
      `INSERT INTO chat_queries (user_id, question, answered) VALUES
       ('1', 'answered question', true),
       ('1', 'unanswered question one', false),
       ('1', 'unanswered question two', false)`
    );

    const res = await agent.get("/api/admin/reporting/knowledge-gaps");
    expect(res.status).toBe(200);
    expect(res.body.gaps).toHaveLength(2);
    const questions = res.body.gaps.map((g: { question: string }) => g.question);
    expect(questions).toContain("unanswered question one");
    expect(questions).toContain("unanswered question two");
    expect(questions).not.toContain("answered question");
  });

  it("returns empty lists (not an error) when there are no chat queries yet", async () => {
    const agent = await loginAsLimeHqUser(app, { id: 1, email: "admin@limehousepm.com", displayName: "Admin Person" });
    const recentRes = await agent.get("/api/admin/reporting/recent-questions");
    expect(recentRes.status).toBe(200);
    expect(recentRes.body.questions).toEqual([]);
    const gapsRes = await agent.get("/api/admin/reporting/knowledge-gaps");
    expect(gapsRes.status).toBe(200);
    expect(gapsRes.body.gaps).toEqual([]);
  });
});
