import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { loadEnv, isRentEngineConnected, isLeadSimpleConnected } from "./config/env.js";
import { dashboardRoutes } from "./api/dashboardRoutes.js";
import { teamPerformanceRoutes } from "./api/teamPerformanceRoutes.js";
import { ceoViewRoutes } from "./api/ceoViewRoutes.js";
import { syncRoutes } from "./api/syncRoutes.js";
import { rentEngineRoutes } from "./api/rentEngineRoutes.js";
import { authRoutes } from "./api/authRoutes.js";
import { staffUsersRoutes } from "./api/staffUsersRoutes.js";
import { getSessionUser } from "./auth/session.js";
import { normalizePath, isGatedHtmlRequest, isAdminOnlyPage } from "./auth/staticPageGate.js";
import { logInfo } from "./lib/logger.js";

// Serves Tron's static dashboard UI (public/) from this same Express app —
// same origin as the API, so no CORS setup is needed for a small internal
// tool. This is one express.static() line, not a second framework/build
// pipeline; the API routes below are untouched.
const env = loadEnv();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public");

const app = express();
app.use(express.json());
app.use(cookieParser());

// Page-level gate, checked BEFORE express.static ever serves an .html file
// (previously /index.html and every other page returned 200 to anyone with
// the link — confirmed live, zero access control). CSS/JS/the login page
// itself/auth routes stay reachable without a session so the login flow and
// its own page can load.
// manage-staff.html added here too, beyond the two pages Oracle's spec named
// explicitly — same reasoning applies (its own API calls would otherwise
// 403 for a Staff-role user who navigates straight to the URL).
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
    res.redirect("/login.html");
    return;
  }

  if (!isGatedHtmlRequest(effectivePath)) {
    next();
    return;
  }

  const user = await getSessionUser(req);
  if (!user) {
    res.redirect("/login.html");
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
app.use(staffUsersRoutes);
app.use(dashboardRoutes);
app.use(teamPerformanceRoutes);
app.use(ceoViewRoutes);
app.use(syncRoutes);
app.use(rentEngineRoutes);

app.listen(env.PORT, () => {
  logInfo("limehouse-dashboard API listening", {
    port: env.PORT,
    rentEngineConnected: isRentEngineConnected(),
    leadSimpleConnected: isLeadSimpleConnected(),
  });
});
