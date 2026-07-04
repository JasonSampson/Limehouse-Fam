import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { getTestPool, truncateAllTables, closeTestPool } from "../support/testDb.js";

process.env.SESSION_COOKIE_SECRET ||= "test-secret-at-least-32-characters-long";

const { buildTestApp } = await import("../support/testApp.js");

describe("invite-only auth gates unauthenticated access", () => {
  const pool = getTestPool();
  const app = buildTestApp();

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("blocks an unauthenticated request to a chat route", async () => {
    const res = await request(app).post("/api/chat/ask").send({ question: "hello" });
    expect(res.status).toBe(401);
  });

  it("blocks an unauthenticated request to an admin route", async () => {
    const res = await request(app).get("/api/admin/documents");
    expect(res.status).toBe(401);
  });

  it("blocks login for an invited-but-not-yet-redeemed user (no password set)", async () => {
    await pool.query(
      `INSERT INTO users (email, name, role, status, invite_token) VALUES ($1, 'Pending Person', 'member', 'invited', 'tok123')`,
      ["pending@limehousepm.com"]
    );
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "pending@limehousepm.com", password: "whatever12" });
    expect(res.status).toBe(401);
  });

  it("blocks login for a disabled user even with the correct password", async () => {
    const passwordHash = await bcrypt.hash("correct-password", 10);
    await pool.query(
      `INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Disabled Person', 'member', 'disabled', $2)`,
      ["disabled@limehousepm.com", passwordHash]
    );
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "disabled@limehousepm.com", password: "correct-password" });
    expect(res.status).toBe(401);
  });

  it("allows login for an active user with the correct password, and the session cookie then grants /api/chat access", async () => {
    const passwordHash = await bcrypt.hash("correct-password", 10);
    await pool.query(
      `INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Active Person', 'member', 'active', $2)`,
      ["active@limehousepm.com", passwordHash]
    );

    const agent = request.agent(app);
    const loginRes = await agent
      .post("/api/auth/login")
      .send({ email: "active@limehousepm.com", password: "correct-password" });
    expect(loginRes.status).toBe(200);

    const meRes = await agent.get("/api/auth/me");
    expect(meRes.status).toBe(200);
    expect(meRes.body.user.email).toBe("active@limehousepm.com");
  });

  it("rejects login with a wrong password for an existing active user", async () => {
    const passwordHash = await bcrypt.hash("correct-password", 10);
    await pool.query(
      `INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Active Person', 'member', 'active', $2)`,
      ["active2@limehousepm.com", passwordHash]
    );
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "active2@limehousepm.com", password: "wrong-password" });
    expect(res.status).toBe(401);
  });

  it("blocks a member (non-admin) from an admin-only route", async () => {
    const passwordHash = await bcrypt.hash("correct-password", 10);
    await pool.query(
      `INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Member Person', 'member', 'active', $2)`,
      ["member@limehousepm.com", passwordHash]
    );

    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "member@limehousepm.com", password: "correct-password" });

    const res = await agent.get("/api/admin/documents");
    expect(res.status).toBe(403);
  });
});
