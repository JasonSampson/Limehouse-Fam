import { Router } from "express";
import { getPool } from "../db/pool.js";
import { requireAdmin } from "../auth/middleware.js";

export const adminReportingRoutes = Router();
adminReportingRoutes.use(requireAdmin);

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
adminReportingRoutes.get("/api/admin/reporting/recent-questions", async (_req, res) => {
  const result = await getPool().query(
    `
    SELECT cq.id, cq.question, cq.answered, cq.created_at,
           COALESCE(u.display_name, u.email) AS asked_by
    FROM chat_queries cq
    LEFT JOIN users u ON u.id::text = cq.user_id
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
    SELECT cq.id, cq.question, cq.created_at,
           COALESCE(u.display_name, u.email) AS asked_by
    FROM chat_queries cq
    LEFT JOIN users u ON u.id::text = cq.user_id
    WHERE cq.answered = false
    ORDER BY cq.created_at DESC
    LIMIT $1
    `,
    [RECENT_QUESTIONS_LIMIT]
  );
  res.json({ gaps: result.rows });
});
