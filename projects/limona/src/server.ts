import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, isChatConnected } from "./config/env.js";
import { attachUser } from "./auth/middleware.js";
import { authRoutes } from "./routes/authRoutes.js";
import { adminDocumentRoutes } from "./routes/adminDocumentRoutes.js";
import { adminDashboardRoutes } from "./routes/adminDashboardRoutes.js";
import { adminAssetRoutes } from "./routes/adminAssetRoutes.js";
import { adminTeamKnowledgeRoutes } from "./routes/adminTeamKnowledgeRoutes.js";
import { adminReportingRoutes } from "./routes/adminReportingRoutes.js";
import { chatRoutes } from "./routes/chatRoutes.js";
import { logInfo } from "./lib/logger.js";

const env = loadEnv();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(helmet());
// TODO(production): add helmet.hsts({ maxAge: 31536000, includeSubDomains: true }) once behind HTTPS
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(attachUser);

app.get("/health", (_req, res) => {
  res.json({ ok: true, chatConnected: isChatConnected() });
});

// Frontend: plain static HTML/CSS/vanilla JS, no build step — matches
// late-rent-notices and limehouse-dashboard's convention. Mounted before the
// authenticated routers so the login/invite pages themselves are reachable;
// each page's own JS calls the JSON API, and those calls go through
// requireAuth/requireAdmin normally.
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// authRoutes has no auth gate (it IS the login/invite flow). chatRoutes
// gates with requireAuth, adminUserRoutes/adminDocumentRoutes/
// adminDashboardRoutes gate with requireAdmin — each applied inside the
// router itself (see those files).
app.use(authRoutes);
app.use(chatRoutes);
app.use(adminDocumentRoutes);
app.use(adminDashboardRoutes);
app.use(adminAssetRoutes);
app.use(adminTeamKnowledgeRoutes);
app.use(adminReportingRoutes);

app.listen(env.PORT, () => {
  logInfo("limona server listening", { port: env.PORT, chatConnected: isChatConnected() });
  if (!isChatConnected()) {
    console.warn(
      "\n=== CHAT NOT FULLY CONFIGURED ===\nANTHROPIC_API_KEY is missing from .env.\nThe app will run and admin document management will work, but the chat feature cannot answer questions until it's set.\n===\n"
    );
  }
});
