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

// Static files (login page, etc.) served last so /auth/* routes take precedence.
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

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
