import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { loadEnv, isRentEngineConnected, isLeadSimpleConnected } from "./config/env.js";
import { dashboardRoutes } from "./api/dashboardRoutes.js";
import { teamPerformanceRoutes } from "./api/teamPerformanceRoutes.js";
import { ceoViewRoutes } from "./api/ceoViewRoutes.js";
import { syncRoutes } from "./api/syncRoutes.js";
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
app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    rentEngineConnected: isRentEngineConnected(),
    leadSimpleConnected: isLeadSimpleConnected(),
  });
});

app.use(dashboardRoutes);
app.use(teamPerformanceRoutes);
app.use(ceoViewRoutes);
app.use(syncRoutes);

app.listen(env.PORT, () => {
  logInfo("limehouse-dashboard API listening", {
    port: env.PORT,
    rentEngineConnected: isRentEngineConnected(),
    leadSimpleConnected: isLeadSimpleConnected(),
  });
});
