import { Router } from "express";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";
import { createTeamKnowledgeEntry } from "../services/teamKnowledgeService.js";
import { logError } from "../lib/logger.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const adminReportingRoutes = Router();
adminReportingRoutes.use(requirePermission("limona.documents.manage"));

// Reasonable simple cap for an internal tool with no pagination UI asked
// for — "last 100" matches the approved spec exactly.
const RECENT_QUESTIONS_LIMIT = 100;

// Recent questions asked, most recent first — one level deeper than the
// Dashboard's summary counts. Limona's local users table is gone, but
// chat_queries.user_id (text, per migration 0009) stores the LimeHQ integer
// user id, and LimeHQ's shared "users" table lives in this same physical
// Supabase database — so we can still JOIN across to it (read-only; Limona
// does not own that table's schema). LEFT JOIN so a question survives even
// if the asking account can't be matched (e.g. pre-migration history, or a
// LimeHQ account since deleted); COALESCE falls back to email when a LimeHQ
// account has no display_name set.
adminReportingRoutes.get("/api/admin/reporting/recent-questions", asyncHandler(async (_req, res) => {
  const result = await getPool().query(
    `
    SELECT cq.id, cq.question, cq.answered, cq.created_at,
           COALESCE(u.display_name, cq.asked_by_name, u.email) AS asked_by
    FROM chat_queries cq
    LEFT JOIN users u ON u.id::text = cq.user_id
    ORDER BY cq.created_at DESC
    LIMIT $1
    `,
    [RECENT_QUESTIONS_LIMIT]
  );
  res.json({ questions: result.rows });
}));

// Removes a single question from the Recent Questions log — a real,
// permanent delete of that one chat_queries row (same "actually delete"
// behavior as Clear Log, just scoped to one row instead of every gap).
adminReportingRoutes.delete("/api/admin/reporting/recent-questions/:id", asyncHandler(async (req, res) => {
  const result = await getPool().query(`DELETE FROM chat_queries WHERE id = $1 RETURNING id`, [req.params.id]);
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Question not found." });
    return;
  }
  res.json({ ok: true });
}));

// Knowledge gaps: questions Limona could not answer.
adminReportingRoutes.get("/api/admin/reporting/knowledge-gaps", asyncHandler(async (_req, res) => {
  const result = await getPool().query(
    `
    SELECT cq.id, cq.question, cq.created_at, cq.draft_answer,
           COALESCE(u.display_name, cq.asked_by_name, u.email) AS asked_by,
           u.email AS asked_by_email
    FROM chat_queries cq
    LEFT JOIN users u ON u.id::text = cq.user_id
    WHERE cq.answered = false
    ORDER BY cq.created_at DESC
    LIMIT $1
    `,
    [RECENT_QUESTIONS_LIMIT]
  );
  res.json({ gaps: result.rows });
}));

const answerSchema = z.object({
  answer: z.string().min(1, "An answer is required."),
});

// Answering a gap from Reporting does two things in one step: saves the
// answer as a new Team Knowledge entry (so future staff asking something
// similar get it automatically — see retrieve.ts), and marks this specific
// chat_queries row as answered so it drops off the Knowledge Gaps list.
// The question text is read back from the DB row rather than trusted from
// the request body, so the saved Team Knowledge entry always matches what
// was actually asked.
adminReportingRoutes.post("/api/admin/reporting/knowledge-gaps/:id/answer", asyncHandler(async (req, res) => {
  const parsed = answerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }

  try {
    const gapResult = await getPool().query(`SELECT question FROM chat_queries WHERE id = $1`, [req.params.id]);
    if (gapResult.rows.length === 0) {
      res.status(404).json({ error: "Question not found." });
      return;
    }
    const { question } = gapResult.rows[0];

    await createTeamKnowledgeEntry(question, parsed.data.answer, req.user!.id, req.user!.name);
    await getPool().query(`UPDATE chat_queries SET answered = true WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logError("Reporting answer-gap failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to save this answer." });
  }
}));

// Dismisses Limona's suggested draft for one gap without answering it —
// the row reverts to a plain, blank "Answer" action, same as a gap that
// never got a draft. The gap itself stays open; only the suggestion goes
// away.
adminReportingRoutes.post("/api/admin/reporting/knowledge-gaps/:id/reject-draft", asyncHandler(async (req, res) => {
  const result = await getPool().query(
    `UPDATE chat_queries SET draft_answer = NULL WHERE id = $1 RETURNING id`,
    [req.params.id]
  );
  if (result.rows.length === 0) {
    res.status(404).json({ error: "Question not found." });
    return;
  }
  res.json({ ok: true });
}));

// "Clear Log" is a real, permanent delete of every currently-listed gap —
// confirmed with Jason: matches the vendor tool exactly, used to clear out
// test/irrelevant questions rather than ones still worth answering.
adminReportingRoutes.delete("/api/admin/reporting/knowledge-gaps", asyncHandler(async (_req, res) => {
  await getPool().query(`DELETE FROM chat_queries WHERE answered = false`);
  res.json({ ok: true });
}));

const MOST_COMMON_LIMIT = 25;

// Groups answered questions by their EXACT text (matching how the vendor
// tool visibly behaves — e.g. "Why is Jason so awesome?" and "Why is Jason
// awesome" are tracked as different questions). Only answered=true rows
// count, since the point is "what did Limona actually answer, and from
// what" — an unanswered gap has nothing to cite yet.
//
// For each of the top N repeat questions this runs two small follow-up
// queries (who asked it, what was cited). That's N+1-shaped, but N is
// capped at 25 and this is a 7-person team's dataset — a few dozen small
// queries is cheap and far simpler to get right than one giant window-
// function query, matching this codebase's "simple over clever" convention
// (see e.g. migration 0004's reasoning for skipping an ivfflat index).
adminReportingRoutes.get("/api/admin/reporting/most-common-questions", asyncHandler(async (_req, res) => {
  const pool = getPool();

  const grouped = await pool.query(
    `
    SELECT question, COUNT(*) AS ask_count
    FROM chat_queries
    WHERE answered = true
    GROUP BY question
    ORDER BY ask_count DESC, MIN(created_at) ASC
    LIMIT $1
    `,
    [MOST_COMMON_LIMIT]
  );

  const results = [];
  for (const row of grouped.rows) {
    const askers = await pool.query(
      `
      SELECT COALESCE(u.display_name, cq.asked_by_name, u.email, 'Unknown user') AS asked_by,
             COUNT(*) AS ask_count
      FROM chat_queries cq
      LEFT JOIN users u ON u.id::text = cq.user_id
      WHERE cq.answered = true AND cq.question = $1
      GROUP BY asked_by
      ORDER BY ask_count DESC
      `,
      [row.question]
    );

    // COUNT(DISTINCT cq.id), not COUNT(*): a single answer can cite several
    // chunks from the same document (e.g. two different pages of one PDF),
    // and that should still only count as "this document was used" once for
    // that ask — matching the vendor tool, where a document's count never
    // exceeds the question's total ask count.
    const documentCites = await pool.query(
      `
      SELECT d.filename, COUNT(DISTINCT cq.id) AS cite_count
      FROM chat_queries cq
      CROSS JOIN LATERAL unnest(cq.top_chunk_ids) AS chunk_id
      JOIN document_chunks dc ON dc.id = chunk_id
      JOIN documents d ON d.id = dc.document_id
      WHERE cq.answered = true AND cq.question = $1
      GROUP BY d.filename
      ORDER BY cite_count DESC
      `,
      [row.question]
    );

    const teamKnowledgeCites = await pool.query(
      `SELECT COUNT(*) AS cite_count FROM chat_queries
       WHERE answered = true AND question = $1 AND top_chunk_ids IS NULL`,
      [row.question]
    );
    const teamKnowledgeCount = Number(teamKnowledgeCites.rows[0].cite_count);

    const documentsCited = documentCites.rows.map((d) => ({ label: d.filename, count: Number(d.cite_count) }));
    if (teamKnowledgeCount > 0) {
      documentsCited.push({ label: "Team Knowledge", count: teamKnowledgeCount });
    }
    documentsCited.sort((a, b) => b.count - a.count);

    // Whether this repeat question is worth suggesting as a "lock this in"
    // promotion to Team Knowledge — already-promoted questions (exact text
    // match) don't get the suggestion again.
    const alreadyPromoted = await pool.query(`SELECT id FROM team_knowledge WHERE question = $1 LIMIT 1`, [
      row.question,
    ]);

    results.push({
      question: row.question,
      askCount: Number(row.ask_count),
      askers: askers.rows.map((a) => ({ name: a.asked_by, count: Number(a.ask_count) })),
      documentsCited,
      alreadyInTeamKnowledge: alreadyPromoted.rows.length > 0,
    });
  }

  res.json({ questions: results });
}));

const promoteCommonQuestionSchema = z.object({
  question: z.string().min(1),
  // Manual override: rows asked before answer_text existed (migration 0014)
  // have nothing saved to promote from. The frontend falls back to a "write
  // the answer" box in that case and resubmits with this filled in.
  answer: z.string().min(1).optional(),
});

// "Lock this in" — turns a repeat question Limona's been successfully
// answering from documents into a permanent Team Knowledge entry, so future
// staff get the instant hand-written answer instead of a fresh document
// search every time. Uses the most recent answer for that question (rather
// than the first) since documents/policies may have been updated since
// earlier asks.
adminReportingRoutes.post("/api/admin/reporting/most-common-questions/promote", asyncHandler(async (req, res) => {
  const parsed = promoteCommonQuestionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }

  try {
    let answer = parsed.data.answer;
    if (!answer) {
      const latest = await getPool().query(
        `SELECT answer_text FROM chat_queries
         WHERE question = $1 AND answered = true AND answer_text IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [parsed.data.question]
      );
      if (latest.rows.length === 0) {
        res.status(422).json({ error: "No saved answer found for this question.", needsManualAnswer: true });
        return;
      }
      answer = latest.rows[0].answer_text;
    }
    await createTeamKnowledgeEntry(parsed.data.question, answer!, req.user!.id, req.user!.name);
    res.json({ ok: true });
  } catch (err) {
    logError("Reporting promote-common-question failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to save this as a Team Knowledge entry." });
  }
}));

const removeCommonQuestionSchema = z.object({
  question: z.string().min(1),
});

// Removes one grouped "Most Common Questions" entry — a real, permanent
// delete of every answered chat_queries row with that exact question text
// (i.e. the whole group shown in that row). Scoped to answered=true only, so
// this never touches an unrelated open Knowledge Gap that happens to share
// the same wording — that's Clear Log's job, not this button's.
adminReportingRoutes.delete("/api/admin/reporting/most-common-questions", asyncHandler(async (req, res) => {
  const parsed = removeCommonQuestionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }
  await getPool().query(`DELETE FROM chat_queries WHERE question = $1 AND answered = true`, [parsed.data.question]);
  res.json({ ok: true });
}));
