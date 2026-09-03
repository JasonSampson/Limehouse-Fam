import { Router } from "express";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";
import { asyncHandler } from "../lib/asyncHandler.js";

// FIXED [today]: this was a blanket router.use(requirePermission(...)) with
// no path scoping. In Express, that runs for EVERY request that reaches
// this router in the app-level middleware chain — not just requests
// matching a route actually defined here — so it was silently intercepting
// and 403-ing requests meant for whichever routers happen to be mounted
// AFTER this one in server.ts (adminAssetRoutes, adminTeamKnowledgeRoutes,
// adminReportingRoutes), regardless of what THEY require. This was masked
// as long as every admin router required the exact same permission; it
// became a real, live bug (Lea unable to load Assets) the moment
// adminAssetRoutes/adminDocumentRoutes split into their own view-vs-manage
// permissions. Same pattern already documented in Dashboard's
// dashboardRoutes.ts for exactly this reason — permission checks now apply
// per-route instead.
export const adminDashboardRoutes = Router();
const manage = requirePermission("limona.documents.manage");

// Read-only aggregate for the admin Dashboard home page's stat cards AND the
// sidebar nav count badges (Document Library, Assets, Team Knowledge, Reporting).
// The Users stat was removed when Limona's local users table was dropped — staff
// management now lives in LimeHQ.
adminDashboardRoutes.get("/api/admin/dashboard-stats", manage, asyncHandler(async (_req, res) => {
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
