import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import { attachUser } from "../../src/auth/middleware.js";
import { authRoutes } from "../../src/routes/authRoutes.js";
import { adminDocumentRoutes } from "../../src/routes/adminDocumentRoutes.js";
import { adminDashboardRoutes } from "../../src/routes/adminDashboardRoutes.js";
import { adminAssetRoutes } from "../../src/routes/adminAssetRoutes.js";
import { adminTeamKnowledgeRoutes } from "../../src/routes/adminTeamKnowledgeRoutes.js";
import { adminReportingRoutes } from "../../src/routes/adminReportingRoutes.js";
import { chatRoutes } from "../../src/routes/chatRoutes.js";

// Builds the same route wiring as src/server.ts, minus app.listen() and
// static file serving (tests hit the JSON API directly) — so DB
// integration tests exercise the real Express app/middleware stack rather
// than calling route handlers in isolation.
export function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachUser);

  app.use(authRoutes);
  app.use(chatRoutes);
  app.use(adminDocumentRoutes);
  app.use(adminDashboardRoutes);
  app.use(adminAssetRoutes);
  app.use(adminTeamKnowledgeRoutes);
  app.use(adminReportingRoutes);

  return app;
}
