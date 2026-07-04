import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { getTestPool, truncateAllTables, closeTestPool } from "../support/testDb.js";
import { installFakeAiProviders, hashToUnitVector } from "../support/fakeAiProviders.js";

installFakeAiProviders();

// Same fake-embedding stub used by ingest.test.ts/retrieve.test.ts — this
// file cares about the Team Knowledge create/list/delete routes and the
// retrieval integration's SQL/routing logic, not the real embedding model.
vi.mock("../../src/rag/embeddings.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/rag/embeddings.js")>();
  return {
    ...original,
    embedChunks: async (texts: string[]) => texts.map((t) => hashToUnitVector(t, 384)),
    embedQuery: vi.fn(async (text: string) => hashToUnitVector(text, 384)),
  };
});

process.env.SESSION_COOKIE_SECRET ||= "test-secret-at-least-32-characters-long";

const { buildTestApp } = await import("../support/testApp.js");
const { retrieveTeamKnowledgeMatch } = await import("../../src/rag/retrieve.js");

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

describe("admin team knowledge routes", () => {
  const pool = getTestPool();
  const app = buildTestApp();

  beforeEach(async () => {
    await truncateAllTables();
  });

  it("blocks an unauthenticated request", async () => {
    const res = await request(app).get("/api/admin/team-knowledge");
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

    const res = await agent.post("/api/admin/team-knowledge").send({ question: "q", answer: "a" });
    expect(res.status).toBe(403);
  });

  it("creates, lists, and deletes an entry end-to-end", async () => {
    const agent = await loginAsAdmin(app);

    const createRes = await agent.post("/api/admin/team-knowledge").send({
      question: "What's the after-hours maintenance number?",
      answer: "Call Property Meld at 555-0100.",
    });
    expect(createRes.status).toBe(200);
    const entryId = createRes.body.id;
    expect(entryId).toBeTruthy();

    const listRes = await agent.get("/api/admin/team-knowledge");
    expect(listRes.status).toBe(200);
    expect(listRes.body.entries).toHaveLength(1);
    expect(listRes.body.entries[0].question).toBe("What's the after-hours maintenance number?");
    expect(listRes.body.entries[0].answer).toBe("Call Property Meld at 555-0100.");

    // The embedding column should be populated, not left null.
    const row = await pool.query("SELECT embedding IS NOT NULL AS has_embedding FROM team_knowledge WHERE id = $1", [
      entryId,
    ]);
    expect(row.rows[0].has_embedding).toBe(true);

    const deleteRes = await agent.delete(`/api/admin/team-knowledge/${entryId}`);
    expect(deleteRes.status).toBe(200);
    const afterDelete = await pool.query("SELECT id FROM team_knowledge WHERE id = $1", [entryId]);
    expect(afterDelete.rows).toHaveLength(0);
  });

  it("rejects create with a missing question or answer", async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent.post("/api/admin/team-knowledge").send({ question: "", answer: "something" });
    expect(res.status).toBe(400);
  });

  it("404s deleting an unknown entry", async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent.delete("/api/admin/team-knowledge/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

describe("retrieveTeamKnowledgeMatch", () => {
  const pool = getTestPool();

  beforeEach(async () => {
    await truncateAllTables();
  });

  it("returns null when there are no Team Knowledge entries", async () => {
    const match = await retrieveTeamKnowledgeMatch("What's the after-hours maintenance number?");
    expect(match).toBeNull();
  });

  it("finds an exact-question match with distance 0 (deterministic fake embedding)", async () => {
    const question = "What's the after-hours maintenance number?";
    const answer = "Call Property Meld at 555-0100.";
    const { embedChunks, toVectorLiteral } = await import("../../src/rag/embeddings.js");
    const [embedding] = await embedChunks([question]);
    await pool.query(
      `INSERT INTO team_knowledge (question, answer, embedding) VALUES ($1, $2, $3::vector)`,
      [question, answer, toVectorLiteral(embedding)]
    );

    const match = await retrieveTeamKnowledgeMatch(question);
    expect(match).not.toBeNull();
    expect(match?.answer).toBe(answer);
    expect(match?.distance).toBeCloseTo(0, 5);
  });
});

describe("chat integration: Team Knowledge is preferred and cited over documents", () => {
  const pool = getTestPool();
  const app = buildTestApp();

  beforeEach(async () => {
    await truncateAllTables();
  });

  // closeTestPool() is called once here (not in the earlier describe blocks
  // above) — all describes in this file share the same module-level pool
  // singleton (see test/support/testDb.ts), so closing it early would break
  // every test in this final block.
  afterAll(async () => {
    await closeTestPool();
  });

  async function loginAsMember() {
    const passwordHash = await bcrypt.hash("correct-password", 10);
    await pool.query(
      `INSERT INTO users (email, name, role, status, password_hash) VALUES ($1, 'Member Person', 'member', 'active', $2)`,
      ["member@limehousepm.com", passwordHash]
    );
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email: "member@limehousepm.com", password: "correct-password" });
    return agent;
  }

  it("answers from Team Knowledge and cites 'Team Knowledge' when a strong match exists, without calling generateAnswer", async () => {
    const agent = await loginAsMember();

    const question = "What's the after-hours maintenance number?";
    const answer = "Call Property Meld at 555-0100.";
    const { embedChunks, toVectorLiteral } = await import("../../src/rag/embeddings.js");
    const [embedding] = await embedChunks([question]);
    await pool.query(
      `INSERT INTO team_knowledge (question, answer, embedding) VALUES ($1, $2, $3::vector)`,
      [question, answer, toVectorLiteral(embedding)]
    );

    const res = await agent.post("/api/chat/ask").send({ question });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe(answer);
    expect(res.body.answered).toBe(true);
    expect(res.body.citations).toEqual([{ documentFilename: "Team Knowledge", pageOrSectionLabel: null }]);

    // Recorded in chat_queries same as a document-backed answer.
    const queryRow = await pool.query("SELECT answered FROM chat_queries WHERE question = $1", [question]);
    expect(queryRow.rows[0].answered).toBe(true);
  });

  it("falls through to normal document retrieval when there is no Team Knowledge match (existing behavior undisturbed)", async () => {
    const agent = await loginAsMember();
    // No Team Knowledge entries and no documents at all.
    const res = await agent.post("/api/chat/ask").send({ question: "Some question nobody has answered" });
    expect(res.status).toBe(200);
    expect(res.body.answered).toBe(false);
    expect(res.body.citations).toEqual([]);
  });
});
