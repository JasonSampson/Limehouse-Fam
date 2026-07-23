import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { getTestPool, truncateAllTables, closeTestPool } from "../support/testDb.js";
import { loginAsLimeHqUser } from "../support/testAuth.js";

process.env.SESSION_COOKIE_SECRET ||= "test-secret-at-least-32-characters-long";

const { buildTestApp } = await import("../support/testApp.js");

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

  it("returns accurate counts across documents and chat_queries", async () => {
    const agent = await loginAsLimeHqUser(app, { id: 1, email: "admin@limehousepm.com", displayName: "Admin Person" });

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
    await pool.query(
      `INSERT INTO chat_queries (user_id, question, answered) VALUES ('1', 'q1', true), ('1', 'q2', true), ('1', 'q3', false)`
    );

    const res = await agent.get("/api/admin/dashboard-stats");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      documentsCount: 1,
      knowledgeGapsCount: 1,
      questionsAskedCount: 3,
      assetsCount: 0,
      teamKnowledgeCount: 0,
    });
  });

  it("counts assets and team_knowledge entries", async () => {
    const agent = await loginAsLimeHqUser(app, { id: 1, email: "admin@limehousepm.com", displayName: "Admin Person" });

    await pool.query(
      `INSERT INTO assets (filename, description, category, size_bytes, storage_path, uploaded_by)
       VALUES ('logo.png', 'Brand logo', 'Branding', 100, 'assets/1/original/logo.png', '1'),
              ('flyer.pdf', 'Flyer template', 'Templates', 200, 'assets/2/original/flyer.pdf', '1')`
    );
    await pool.query(
      `INSERT INTO team_knowledge (question, answer, embedding, created_by)
       VALUES ('Where is the thermostat?', 'In the hallway closet.', $1, '1')`,
      [`[${Array(384).fill(0).join(",")}]`]
    );

    const res = await agent.get("/api/admin/dashboard-stats");
    expect(res.status).toBe(200);
    expect(res.body.assetsCount).toBe(2);
    expect(res.body.teamKnowledgeCount).toBe(1);
  });
});
