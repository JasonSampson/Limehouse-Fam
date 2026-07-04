import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { getTestPool, truncateAllTables, closeTestPool } from "../support/testDb.js";

process.env.SESSION_COOKIE_SECRET ||= "test-secret-at-least-32-characters-long";

const { buildTestApp } = await import("../support/testApp.js");

async function loginAsAdmin(app: ReturnType<typeof buildTestApp>) {
  const pool = getTestPool();
  const passwordHash = await bcrypt.hash("correct-password", 10);
  await pool.query(
    `INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Admin Person', 'admin', 'active', $2)`,
    ["admin@limehousepm.com", passwordHash]
  );
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({ email: "admin@limehousepm.com", password: "correct-password" });
  return agent;
}

describe("GET /api/admin/dashboard-stats", () => {
  const pool = getTestPool();
  const app = buildTestApp();

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("blocks an unauthenticated request", async () => {
    const res = await request(app).get("/api/admin/dashboard-stats");
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

    const res = await agent.get("/api/admin/dashboard-stats");
    expect(res.status).toBe(403);
  });

  it("returns accurate counts across documents, users, and chat_queries", async () => {
    const agent = await loginAsAdmin(app);

    // Two more users beyond the admin created in loginAsAdmin: one active, one invited.
    await pool.query(
      `INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Active Member', 'member', 'active', 'x')`,
      ["active-member@limehousepm.com"]
    );
    await pool.query(
      `INSERT INTO users (email, name, role, status, invite_token) VALUES ($1, 'Invited Member', 'member', 'invited', 'tok-abc')`,
      ["invited-member@limehousepm.com"]
    );

    // Documents: one ready, one processing, one superseded — only "ready" counts.
    await pool.query(
      `INSERT INTO documents (filename, category_id, file_size_bytes, file_ext, storage_path, status)
       VALUES ('a.pdf', 1, 100, '.pdf', 'documents/a/original/a.pdf', 'ready')`
    );
    await pool.query(
      `INSERT INTO documents (filename, category_id, file_size_bytes, file_ext, storage_path, status)
       VALUES ('b.pdf', 1, 100, '.pdf', 'documents/b/original/b.pdf', 'processing')`
    );
    await pool.query(
      `INSERT INTO documents (filename, category_id, file_size_bytes, file_ext, storage_path, status)
       VALUES ('c.pdf', 1, 100, '.pdf', 'documents/c/original/c.pdf', 'superseded')`
    );

    // chat_queries: 2 answered, 1 not answered.
    const adminId = (await pool.query("SELECT id FROM users WHERE email = 'admin@limehousepm.com'")).rows[0].id;
    await pool.query(
      `INSERT INTO chat_queries (user_id, question, answered) VALUES ($1, 'q1', true), ($1, 'q2', true), ($1, 'q3', false)`,
      [adminId]
    );

    const res = await agent.get("/api/admin/dashboard-stats");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      documentsCount: 1,
      knowledgeGapsCount: 1,
      questionsAskedCount: 3,
      teamMembers: { admin: 1, member: 2, invited: 1 },
    });
  });

  it("does not conflate active member accounts into the admin count", async () => {
    // Reproduces the bug TARS found: 2 admins + 1 member, all status='active',
    // previously rendered as "3 admin" because the query only counted by
    // status, not role. Assert role and status are counted independently.
    const agent = await loginAsAdmin(app); // 1 admin, status='active'
    await pool.query(
      `INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Second Admin', 'admin', 'active', 'x')`,
      ["second-admin@limehousepm.com"]
    );
    await pool.query(
      `INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Active Member', 'member', 'active', 'x')`,
      ["active-member@limehousepm.com"]
    );

    const res = await agent.get("/api/admin/dashboard-stats");
    expect(res.status).toBe(200);
    expect(res.body.teamMembers).toEqual({ admin: 2, member: 1, invited: 0 });
  });
});
