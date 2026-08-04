import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { loadEnv, isRentEngineConnected, isLeadSimpleConnected } from "./config/env.js";
import { dashboardRoutes } from "./api/dashboardRoutes.js";
import { teamPerformanceRoutes } from "./api/teamPerformanceRoutes.js";
import { ceoViewRoutes } from "./api/ceoViewRoutes.js";
import { syncRoutes } from "./api/syncRoutes.js";
import { rentEngineRoutes } from "./api/rentEngineRoutes.js";
import { authRoutes } from "./api/authRoutes.js";
import { getSessionUser } from "./auth/session.js";
import { normalizePath, isGatedHtmlRequest, isAdminOnlyPage } from "./auth/staticPageGate.js";
import { logInfo, logError } from "./lib/logger.js";
import { startScheduledCacheRefresh } from "./jobs/scheduler.js";

// Serves Tron's static dashboard UI (public/) from this same Express app —
// same origin as the API, so no CORS setup is needed for a small internal
// tool. This is one express.static() line, not a second framework/build
// pipeline; the API routes below are untouched.
const env = loadEnv();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

const app = express();
app.use(helmet());
// TODO(production): add helmet.hsts({ maxAge: 31536000, includeSubDomains: true }) once behind HTTPS
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Page-level gate, checked BEFORE express.static ever serves an .html file
// (previously /index.html and every other page returned 200 to anyone with
// the link — confirmed live, zero access control). CSS/JS/auth routes stay
// reachable without a session so the page shell can load its assets and the
// LimeHQ handoff flow (/auth/limehq-callback) can complete. There's no local
// login page anymore — LimeHQ is the single front door (see authRoutes.ts).
app.use(async (req, res, next) => {
  // "/" resolves to index.html via express.static's default-document
  // behavior below, so it must be gated the same way an explicit
  // "/index.html" request is — otherwise the page shell loads
  // unauthenticated (confirmed live: without this, GET / returned 200 with
  // no session at all).
  //
  // req.path is raw/undecoded, so both a case bypass (GET /CEO-VIEW.HTML)
  // and a percent-encoding bypass (GET /ceo-view%2ehtml, which express.static
  // decodes to ceo-view.html downstream but which doesn't end in ".html" as
  // raw text) previously slipped past the checks below (both confirmed live
  // by Sentinel). normalizePath decodes once and lowercases the result so
  // every comparison after this line sees the same fully-normalized value
  // express.static will ultimately act on.
  //
  // A malformed percent-sequence makes decodeURIComponent throw; normalizePath
  // returns null in that case. Treat null as suspicious and deny outright
  // (redirect to login) rather than let it fall through to next() — an
  // un-normalizable path has no business reaching express.static unchecked.
  const effectivePath = normalizePath(req.path);
  if (effectivePath === null) {
    res.redirect(`${env.LIMEHQ_URL}/auth/handoff?app=dashboard`);
    return;
  }

  if (!isGatedHtmlRequest(effectivePath)) {
    next();
    return;
  }

  const user = await getSessionUser(req);
  if (!user) {
    res.redirect(`${env.LIMEHQ_URL}/auth/handoff?app=dashboard`);
    return;
  }

  // Quieter than letting the page load and having its API calls fail with
  // 403s — a Staff-role user who navigates straight to an Admin-only page
  // just lands back on their own Dashboard instead of a broken page.
  if (user.role !== "admin" && isAdminOnlyPage(effectivePath)) {
    res.redirect("/index.html");
    return;
  }

  next();
});

app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    rentEngineConnected: isRentEngineConnected(),
    leadSimpleConnected: isLeadSimpleConnected(),
  });
});

app.use(authRoutes);
app.use(dashboardRoutes);
app.use(teamPerformanceRoutes);
app.use(ceoViewRoutes);
app.use(syncRoutes);
app.use(rentEngineRoutes);

// Catch-all error handler — MUST be registered last (Express identifies an
// error-handling middleware purely by its 4-argument signature) and MUST
// have all 4 params even though `next` is unused, or Express treats it as
// a normal middleware and skips it entirely. Every route handler above is
// wrapped in asyncHandler (src/lib/asyncHandler.ts), which forwards any
// thrown/rejected error here via next(err) instead of letting it become an
// unhandled promise rejection. Without this, one bad request (a Buildium/
// RentEngine/LeadSimple failure, a database hiccup, anything) crashed the
// ENTIRE server for every user — same bug late-rent-notices hit on
// 2026-08-04, fixed there the same way. This turns that into a normal
// error response for the one request that hit it; everyone else keeps
// working.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // FIXED during live verification: logError's own signature is
  // (message, fields) and spreads fields OVER the message key internally
  // (src/lib/logger.ts) — a field literally named `message` silently
  // clobbers the descriptive label passed as the first argument. Every
  // other logError call in this codebase already avoids this by naming the
  // field `error`, not `message`; matched that convention here after
  // confirming live that `{ message }` was swallowing "unhandled route
  // error" from the logged output.
  const errorMessage = err instanceof Error ? err.message : String(err);
  logError("unhandled route error", { error: errorMessage, path: req.path, method: req.method });
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
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  logError("unhandled promise rejection — process kept running", { error: errorMessage });
});
process.on("uncaughtException", (err) => {
  logError("uncaught exception — process kept running", { error: err.message });
});

app.listen(env.PORT, () => {
  logInfo("limehouse-dashboard API listening", {
    port: env.PORT,
    rentEngineConnected: isRentEngineConnected(),
    leadSimpleConnected: isLeadSimpleConnected(),
  });
  // Keeps dashboard_metric_cache warm in the background so no page load
  // ever has to wait on a live sync — see src/jobs/scheduler.ts.
  startScheduledCacheRefresh();
});
