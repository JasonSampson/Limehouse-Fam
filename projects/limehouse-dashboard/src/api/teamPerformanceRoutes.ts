import { Router } from "express";
import { z } from "zod";
import { checkTeamPerformancePassword, isTeamPerformancePasswordSet } from "../db/settings.js";
import { issueUnlockedCookie, requireTeamPerformanceUnlocked } from "./session.js";
import { getScoredRoles } from "../db/kpiRepository.js";
import { periodToSnapshotLabel, type PeriodKey } from "../kpi/period.js";
import { logError } from "../lib/logger.js";

export const teamPerformanceRoutes = Router();

const passwordCheckSchema = z.object({ password: z.string().min(1) });

// No per-user accounts (per project brief) — one shared password, checked
// against dashboard_settings.team_performance_password_hash. A correct
// password sets a signed "unlocked" cookie; wrong password OR no password
// configured yet both return 401 with the same message (see
// src/db/settings.ts comment on why those two cases aren't distinguished
// in the response).
teamPerformanceRoutes.post("/api/team-performance/check-password", async (req, res) => {
  const parsed = passwordCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Password is required." });
    return;
  }
  try {
    const ok = await checkTeamPerformancePassword(parsed.data.password);
    if (!ok) {
      res.status(401).json({ error: "Incorrect password." });
      return;
    }
    issueUnlockedCookie(res);
    res.json({ ok: true });
  } catch (err) {
    logError("POST /api/team-performance/check-password failed", { error: String(err) });
    res.status(500).json({ error: "Failed to check password." });
  }
});

// Lets the frontend show "ask Jason to set a password" vs. a normal
// password prompt, without ever revealing whether a guess was close.
teamPerformanceRoutes.get("/api/team-performance/status", async (_req, res) => {
  try {
    res.json({ passwordConfigured: await isTeamPerformancePasswordSet() });
  } catch (err) {
    logError("GET /api/team-performance/status failed", { error: String(err) });
    res.status(500).json({ error: "Failed to check Team Performance status." });
  }
});

const periodQuerySchema = z
  .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year"])
  .default("this_quarter");

// requireTeamPerformanceUnlocked is applied per-route (not via a blanket
// teamPerformanceRoutes.use(...)) because this router is mounted at the
// app root with no path prefix (app.use(teamPerformanceRoutes) in
// server.ts) — an unscoped .use() here would match "/" and therefore catch
// EVERY request that reaches this router's dispatch chain, including ones
// destined for other routers mounted after it (e.g. /api/sync/status),
// not just this router's own /api/team-performance/* routes. This was
// caught by a live smoke test: /api/sync/status returned 401 "Team
// Performance tab is locked" before this fix.
teamPerformanceRoutes.get("/api/team-performance/roles", requireTeamPerformanceUnlocked, async (req, res) => {
  const parsed = periodQuerySchema.safeParse(req.query.period);
  const period: PeriodKey = parsed.success ? parsed.data : "this_quarter";
  const snapshotLabel = periodToSnapshotLabel(period);
  try {
    const roles = await getScoredRoles(snapshotLabel, "team_performance");
    res.json({ period: snapshotLabel, roles });
  } catch (err) {
    logError("GET /api/team-performance/roles failed", { error: String(err) });
    res.status(500).json({ error: "Failed to load Team Performance data." });
  }
});
