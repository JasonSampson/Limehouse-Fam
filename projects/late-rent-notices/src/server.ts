import express from "express";
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
import { logInfo } from "./lib/appLogger.js";

const env = loadEnv();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
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
  }
});
