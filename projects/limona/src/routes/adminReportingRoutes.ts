import { Router } from "express";
import { getPool } from "../db/pool.js";
import { requireAdmin } from "../auth/middleware.js";

export const adminReportingRoutes = Router();
adminReportingRoutes.use(requireAdmin);

// Reasonable simple cap for an internal tool with no pagination UI asked
// for — "last 100" matches the approved spec exactly.
const RECENT_QUESTIONS_LIMIT = 100;

// Recent questions asked, most recent first — one level deeper than the
// Dashboard's summary counts. The users JOIN was removed when Limona's local
// users table was dropped; asked_by is now the LimeHQ user_id stored in
// chat_queries.user_id (text column after migration 0009).
adminReportingRoutes.get("/api/admin/reporting/recent-questions", async (_req, res) => {
  const result = await getPool().query(
    `
    SELECT cq.id, cq.question, cq.answered, cq.created_at, cq.user_id AS asked_by
    FROM chat_queries cq
    ORDER BY cq.created_at DESC
    LIMIT $1
    `,
    [RECENT_QUESTIONS_LIMIT]
  );
  res.json({ questions: result.rows });
});

// Knowledge gaps: questions Limona could not answer.
adminReportingRoutes.get("/api/admin/reporting/knowledge-gaps", async (_req, res) => {
  const result = await getPool().query(
    `
    SELECT cq.id, cq.question, cq.created_at, cq.user_id AS asked_by
    FROM chat_queries cq
    WHERE cq.answered = false
    ORDER BY cq.created_at DESC
    LIMIT $1
    `,
    [RECENT_QUESTIONS_LIMIT]
  );
  res.json({ gaps: result.rows });
});
