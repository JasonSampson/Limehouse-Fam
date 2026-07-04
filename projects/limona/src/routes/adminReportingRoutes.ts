import { Router } from "express";
import { getPool } from "../db/pool.js";
import { requireAdmin } from "../auth/middleware.js";

export const adminReportingRoutes = Router();
adminReportingRoutes.use(requireAdmin);

// Reasonable simple cap for an internal tool with no pagination UI asked
// for — "last 100" matches the approved spec exactly.
const RECENT_QUESTIONS_LIMIT = 100;

// Recent questions asked, most recent first — one level deeper than the
// Dashboard's summary counts. Joins to users for a friendly display name;
// LEFT JOIN so a query still shows up even if the asking user was later
// deleted (users are only ever disabled in this app, not deleted, but this
// keeps the query correct even if that ever changes).
adminReportingRoutes.get("/api/admin/reporting/recent-questions", async (_req, res) => {
  const result = await getPool().query(
    `
    SELECT cq.id, cq.question, cq.answered, cq.created_at, u.name AS asked_by
    FROM chat_queries cq
    LEFT JOIN users u ON u.id = cq.user_id
    ORDER BY cq.created_at DESC
    LIMIT $1
    `,
    [RECENT_QUESTIONS_LIMIT]
  );
  res.json({ questions: result.rows });
});

// Knowledge gaps: questions Limona could not answer — these are the real
// content gaps admins should consider fixing (upload a document, or add a
// Team Knowledge entry). Same limit/ordering as recent-questions.
adminReportingRoutes.get("/api/admin/reporting/knowledge-gaps", async (_req, res) => {
  const result = await getPool().query(
    `
    SELECT cq.id, cq.question, cq.created_at, u.name AS asked_by
    FROM chat_queries cq
    LEFT JOIN users u ON u.id = cq.user_id
    WHERE cq.answered = false
    ORDER BY cq.created_at DESC
    LIMIT $1
    `,
    [RECENT_QUESTIONS_LIMIT]
  );
  res.json({ gaps: result.rows });
});
