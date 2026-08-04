import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { authRoutes } from "./routes/authRoutes.js";
import { noticeRoutes } from "./routes/noticeRoutes.js";
import { exclusionRoutes } from "./routes/exclusionRoutes.js";
import { leaseRoutes } from "./routes/leaseRoutes.js";
import { contactAttemptRoutes } from "./routes/contactAttemptRoutes.js";
import { meRoutes } from "./routes/meRoutes.js";
import { searchRoutes } from "./routes/searchRoutes.js";
import { pmAssignmentRoutes } from "./routes/pmAssignmentRoutes.js";
import { logInfo, logWarn, logError } from "./lib/appLogger.js";

const env = loadEnv();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(helmet());
// TODO(production): add helmet.hsts({ maxAge: 31536000, includeSubDomains: true }) once behind HTTPS
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ ok: true, shadowMode: env.SHADOW_MODE });
});

// Frontend: plain static HTML/CSS/vanilla JS, no build step. Mounted BEFORE
// the authenticated routers below — every one of those routers calls
// `.use(requireSession)` with no path scoping, so it runs on every request
// that reaches it, including requests for /index.html or /css/style.css.
// If static serving were mounted after, every page and asset would 401
// before a user is even signed in, and the login page itself would be
// unreachable. Auth-gating for actual page data still happens correctly:
// the pages are static shells that call the JSON API client-side, and
// those /api/* calls still go through requireSession normally.
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

app.use(authRoutes);
app.use(noticeRoutes);
app.use(exclusionRoutes);
app.use(leaseRoutes);
app.use(contactAttemptRoutes);
app.use(meRoutes);
app.use(searchRoutes);
app.use(pmAssignmentRoutes);

// Catch-all error handler — MUST be registered last (Express identifies an
// error-handling middleware purely by its 4-argument signature) and MUST
// have all 4 params even though `next` is unused, or Express treats it as
// a normal middleware and skips it entirely. Every route handler above is
// wrapped in asyncHandler (src/lib/asyncHandler.ts), which forwards any
// thrown/rejected error here via next(err) instead of letting it become an
// unhandled promise rejection. Without this, one bad request (a rejected
// database write, a Buildium timeout, anything) crashed the ENTIRE server
// for every user — exactly what happened on 2026-08-04. This turns that
// into a normal error response for the one request that hit it; everyone
// else keeps working.
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
  logInfo(`late-rent-notices server listening`, { port: env.PORT, shadowMode: env.SHADOW_MODE });
  if (env.SHADOW_MODE) {
    console.log(
      "\n=== SHADOW MODE ACTIVE ===\nDrafts will be generated normally; Send is a no-op that logs what would have happened.\nThis is the required default — flip SHADOW_MODE=false only after an explicit, separate decision.\n===\n"
    );
  } else {
    console.warn(
      "\n!!! LIVE MODE — SHADOW_MODE=false !!!\nReal notices will be emailed to real tenants. Confirm this is intentional.\n"
    );
    // Procedural safeguard (Asimov): SHADOW_MODE=false is the switch that
    // makes this app start actually sending real notices to tenants instead
    // of just drafting them. There's no approval workflow gating that flip
    // yet — this is the lightweight version: an unmissable, structured,
    // timestamped record every single time the server boots in live-send
    // mode, so "when did live mode start" is never a question anyone has to
    // guess at from memory.
    logWarn("SHADOW MODE DISABLED — server booted in LIVE SEND mode. Real notices will be emailed to real tenants.", {
      jobName: "server_startup",
    });
  }
});
