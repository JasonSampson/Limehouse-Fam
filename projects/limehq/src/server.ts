import express from "express";
import type { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { logInfo, logError } from "./lib/appLogger.js";
import { authRouter } from "./auth/authRoutes.js";
import { ApiError } from "./lib/apiError.js";

const env = loadEnv();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(cookieParser());

// Health check — no auth required.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Auth routes: login, logout, re-auth, me, handoff.
app.use("/auth", authRouter);

// Static files (login page, fonts, etc.) served before catch-all routes.
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

// Launcher placeholder — Tron will replace this with the real app-tile page.
app.get("/launcher", (_req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>LimeHQ — Launcher</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
    body { font-family: system-ui, sans-serif; background: #f0f4f0;
           display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; }
    .card { background: #fff; border-radius: 14px; padding: 2.5rem 2rem;
            max-width: 420px; width: 100%; box-shadow: 0 2px 20px rgba(0,0,0,.09);
            text-align: center; }
    h1 { color: #009344; font-size: 1.5rem; margin: 0 0 .5rem; }
    p  { color: #555; margin: 0 0 1.5rem; font-size: .95rem; }
    a  { display: inline-block; padding: .6rem 1.25rem; background: #74b62e;
         color: #fff; border-radius: 7px; text-decoration: none; font-weight: 700; }
    a:hover { background: #67a228; }
  </style>
</head>
<body>
  <div class="card">
    <h1>You're in.</h1>
    <p>The app launcher is being built. In the meantime you can head straight to Late Rent Notices.</p>
    <a href="http://localhost:3100">Late Rent Notices →</a>
  </div>
</body>
</html>`);
});

// Global error handler — catches ApiError and unexpected errors alike.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ ok: false, error: err.message });
    return;
  }
  logError("Unhandled server error", { error: String(err) });
  res.status(500).json({ ok: false, error: "Internal server error" });
});

app.listen(env.PORT, () => {
  logInfo("limehq server listening", { port: env.PORT });
});
