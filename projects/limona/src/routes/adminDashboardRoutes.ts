import { Router } from "express";
import { getPool } from "../db/pool.js";
import { requireAdmin } from "../auth/middleware.js";

export const adminDashboardRoutes = Router();
adminDashboardRoutes.use(requireAdmin);

// Read-only aggregate for the admin Dashboard home page's stat cards AND the
// sidebar nav count badges (Document Library, Assets, Team Knowledge, Users,
// Reporting). No writes, no new tables — every number here is a count over
// existing data (documents, users, chat_queries, assets, team_knowledge).
// Kept as its own file/router rather than folding into adminDocumentRoutes or
// adminUserRoutes so each of those stays focused on its own resource.
adminDashboardRoutes.get("/api/admin/dashboard-stats", async (_req, res) => {
  const [documentsResult, usersResult, queriesResult, assetsResult, teamKnowledgeResult] = await Promise.all([
    getPool().query("SELECT count(*)::int AS count FROM documents WHERE status = 'ready'"),
    getPool().query(
      `SELECT
         count(*) FILTER (WHERE role = 'admin')::int AS admin_count,
         count(*) FILTER (WHERE role = 'member')::int AS member_count,
         count(*) FILTER (WHERE status = 'invited')::int AS invited_count
       FROM users`
    ),
    getPool().query(
      `SELECT
         count(*)::int AS total_count,
         count(*) FILTER (WHERE answered = false)::int AS unanswered_count
       FROM chat_queries`
    ),
    getPool().query("SELECT count(*)::int AS count FROM assets"),
    getPool().query("SELECT count(*)::int AS count FROM team_knowledge"),
  ]);

  const users = usersResult.rows[0];
  const queries = queriesResult.rows[0];

  res.json({
    documentsCount: documentsResult.rows[0].count,
    knowledgeGapsCount: queries.unanswered_count,
    questionsAskedCount: queries.total_count,
    assetsCount: assetsResult.rows[0].count,
    teamKnowledgeCount: teamKnowledgeResult.rows[0].count,
    teamMembers: {
      admin: users.admin_count,
      member: users.member_count,
      invited: users.invited_count,
    },
  });
});
