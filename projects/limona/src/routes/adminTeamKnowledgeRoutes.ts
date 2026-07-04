import { Router } from "express";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireAdmin } from "../auth/middleware.js";
import { embedQuery, toVectorLiteral } from "../rag/embeddings.js";
import { logError } from "../lib/logger.js";

export const adminTeamKnowledgeRoutes = Router();
adminTeamKnowledgeRoutes.use(requireAdmin);

adminTeamKnowledgeRoutes.get("/api/admin/team-knowledge", async (_req, res) => {
  const result = await getPool().query(
    `SELECT id, question, answer, created_at, updated_at FROM team_knowledge ORDER BY created_at DESC`
  );
  res.json({ entries: result.rows });
});

const createSchema = z.object({
  question: z.string().min(1, "A question is required."),
  answer: z.string().min(1, "An answer is required."),
});

// The question text is embedded with the SAME local model used for document
// chunks (src/rag/embeddings.ts) so retrieve.ts can compare Team Knowledge
// entries and document chunks on one common distance scale.
adminTeamKnowledgeRoutes.post("/api/admin/team-knowledge", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }
  const { question, answer } = parsed.data;

  try {
    const embedding = await embedQuery(question);
    const result = await getPool().query(
      `INSERT INTO team_knowledge (question, answer, embedding, created_by)
       VALUES ($1, $2, $3::vector, $4)
       RETURNING id`,
      [question, answer, toVectorLiteral(embedding), req.user!.id]
    );
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    logError("Team Knowledge create failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to save this entry." });
  }
});

adminTeamKnowledgeRoutes.delete("/api/admin/team-knowledge/:id", async (req, res) => {
  const result = await getPool().query("DELETE FROM team_knowledge WHERE id = $1 RETURNING id", [
    req.params.id,
  ]);
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Entry not found." });
    return;
  }
  res.json({ ok: true });
});
