import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { logInfo } from "./lib/appLogger.js";

// Scaffolding only — this is Scotty's setup pass. The real login routes,
// role/permission checks, and Manage Staff screen come later from Q,
// built against Oracle's spec (docs/auth-spec.md) and Neo's data model.
// Intentionally no auth routes are wired yet: there is nothing to protect
// on this bare skeleton, and wiring a half-built login would be worse than
// wiring none.
const env = loadEnv();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

app.listen(env.PORT, () => {
  logInfo("limehq server listening", { port: env.PORT });
});
