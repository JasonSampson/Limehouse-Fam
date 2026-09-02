import { Router } from "express";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const adminDashboardRoutes = Router();
adminDashboardRoutes.use(requirePermission("limona.documents.manage"));

// Read-only aggregate for the admin Dashboard home page's stat cards AND the
// sidebar nav count badges (Document Library, Assets, Team Knowledge, Reporting).
// The Users stat was removed when Limona's local users table was dropped — staff
// management now lives in LimeHQ.
adminDashboardRoutes.get("/api/admin/dashboard-stats", asyncHandler(async (_req, res) => {
  const [documentsResult, queriesResult, assetsResult, teamKnowledgeResult] = await Promise.all([
    getPool().query("SELECT count(*)::int AS count FROM documents WHERE status = 'ready'"),
    getPool().query(
      `SELECT
         count(*)::int AS total_count,
         count(*) FILTER (WHERE answered = false)::int AS unanswered_count
       FROM chat_queries`
    ),
    getPool().query("SELECT count(*)::int AS count FROM assets"),
    getPool().query("SELECT count(*)::int AS count FROM team_knowledge"),
  ]);

  const queries = queriesResult.rows[0];

  res.json({
    documentsCount: documentsResult.rows[0].count,
    knowledgeGapsCount: queries.unanswered_count,
    questionsAskedCount: queries.total_count,
    assetsCount: assetsResult.rows[0].count,
    teamKnowledgeCount: teamKnowledgeResult.rows[0].count,
    // teamMembers removed — user management is now handled in LimeHQ
  });
}));
