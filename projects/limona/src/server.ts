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
import { logInfo, logError } from "./lib/logger.js";

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
// gates with requireAuth, adminDocumentRoutes/adminDashboardRoutes and the
// other admin routers gate with requireAdmin — each applied inside the
// router itself (see those files).
app.use(authRoutes);
app.use(chatRoutes);
app.use(adminDocumentRoutes);
app.use(adminDashboardRoutes);
app.use(adminAssetRoutes);
app.use(adminTeamKnowledgeRoutes);
app.use(adminReportingRoutes);

// Catch-all error handler — MUST be registered last (Express identifies an
// error-handling middleware purely by its 4-argument signature) and MUST
// have all 4 params even though `next` is unused, or Express treats it as
// a normal middleware and skips it entirely. Every route handler above is
// wrapped in asyncHandler (src/lib/asyncHandler.ts), which forwards any
// thrown/rejected error here via next(err) instead of letting it become an
// unhandled promise rejection. Without this, one bad request (a database
// hiccup, a PDF that trips a parsing edge case, anything) crashed the
// ENTIRE server for every user — the same failure shape found in
// late-rent-notices on 2026-08-04. This turns that into a normal error
// response for the one request that hit it; everyone else keeps working.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  logError("unhandled route error", { message, path: req.path, method: req.method });
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong on our end. Nothing was changed — please try again." });
});

// Last-resort backstop for anything that manages to bypass asyncHandler
// entirely (middleware itself throwing, a background job's own unawaited
// promise) — log it and keep the process running instead of letting Node's
// default behavior (crash on unhandled rejection since Node 15) take the
// whole site down. This does not replace asyncHandler; it's defense in
// depth for the one class of error asyncHandler can't see.
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logError("unhandled promise rejection — process kept running", { message });
});
process.on("uncaughtException", (err) => {
  logError("uncaught exception — process kept running", { message: err.message });
});

app.listen(env.PORT, () => {
  logInfo("limona server listening", { port: env.PORT, chatConnected: isChatConnected() });
  if (!isChatConnected()) {
    console.warn(
      "\n=== CHAT NOT FULLY CONFIGURED ===\nANTHROPIC_API_KEY is missing from .env.\nThe app will run and admin document management will work, but the chat feature cannot answer questions until it's set.\n===\n"
    );
  }
});
