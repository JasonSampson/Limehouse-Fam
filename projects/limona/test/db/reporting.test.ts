import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { getTestPool, truncateAllTables, closeTestPool } from "../support/testDb.js";

process.env.SESSION_COOKIE_SECRET ||= "test-secret-at-least-32-characters-long";

const { buildTestApp } = await import("../support/testApp.js");

async function loginAsAdmin(app: ReturnType<typeof buildTestApp>) {
  const pool = getTestPool();
  const passwordHash = await bcrypt.hash("correct-password", 10);
  const result = await pool.query(
    `INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Admin Person', 'admin', 'active', $2) RETURNING id`,
    ["admin@limehousepm.com", passwordHash]
  );
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: "admin@limehousepm.com", password: "correct-password" });
  return { agent, adminId: result.rows[0].id };
}

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

  it("blocks a non-admin (member) request", async () => {
    const passwordHash = await bcrypt.hash("correct-password", 10);
    await pool.query(
      `INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Member Person', 'member', 'active', $2)`,
      ["member@limehousepm.com", passwordHash]
    );
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "member@limehousepm.com", password: "correct-password" });

    const res = await agent.get("/api/admin/reporting/recent-questions");
    expect(res.status).toBe(403);
  });

  it("lists recent questions most-recent-first with answered flag and asker name", async () => {
    const { agent, adminId } = await loginAsAdmin(app);

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

  it("only surfaces answered=false questions as knowledge gaps", async () => {
    const { agent, adminId } = await loginAsAdmin(app);

    await pool.query(
      `INSERT INTO chat_queries (user_id, question, answered) VALUES
       ($1, 'answered question', true),
       ($1, 'unanswered question one', false),
       ($1, 'unanswered question two', false)`,
      [adminId]
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
    const { agent } = await loginAsAdmin(app);
    const recentRes = await agent.get("/api/admin/reporting/recent-questions");
    expect(recentRes.status).toBe(200);
    expect(recentRes.body.questions).toEqual([]);
    const gapsRes = await agent.get("/api/admin/reporting/knowledge-gaps");
    expect(gapsRes.status).toBe(200);
    expect(gapsRes.body.gaps).toEqual([]);
  });
});
