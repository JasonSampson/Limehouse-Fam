import { Router } from "express";
import { jwtVerify } from "jose";
import { createSessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from "../auth/session.js";
import { getAppPool } from "../db/pool.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace } from "../lib/trace.js";
import { loadEnv } from "../config/env.js";

export const authRoutes = Router();

// Accepts a short-lived handoff token from LimeHQ and issues a Late Rent
// Notices session. LimeHQ redirects here after login so staff don't need
// a separate password for this app.
authRoutes.get("/auth/limehq-callback", async (req, res) => {
  const trace = startTrace();
  const token = req.query.token;
  if (typeof token !== "string") {
    res.status(400).send("Invalid sign-in link.");
    return;
  }
  try {
    const env = loadEnv();
    const secret = new TextEncoder().encode(env.LIMEHQ_HANDOFF_SECRET);
    const { payload } = await jwtVerify(token, secret);
    const email = payload.email as string;

    const pool = getAppPool();
    const result = await pool.query<{
      id: number;
      is_fallback_decision_maker: boolean;
      active: boolean;
    }>(
      "SELECT id, is_fallback_decision_maker, active FROM pm_users WHERE lower(email) = lower($1)",
      [email]
    );

    const pm = result.rows[0];
    if (!pm || !pm.active) {
      res.status(403).send("Your LimeHQ account does not have access to Late Rent Notices. Contact Jason.");
      return;
    }

    const sessionToken = await createSessionToken({
      pmUserId: pm.id,
      email,
      isFallbackDecisionMaker: pm.is_fallback_decision_maker,
      authenticatedAt: Date.now(),
    });

    res.cookie(SESSION_COOKIE_NAME, sessionToken, sessionCookieOptions());

    await writeAuditLog(pool, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      actorType: pm.is_fallback_decision_maker ? "fallback_decision_maker" : "pm",
      actorId: String(pm.id),
      eventType: "auth.login",
      eventSummary: `PM ${pm.id} logged in via LimeHQ handoff.`,
      eventData: {},
      contextSnapshot: {},
      privacyCategory: "Identification",
      regulationTags: [],
      riskLevel: "low",
      legalBasis: "authentication",
      retentionPolicy: "retain_1_year",
      trace,
    });

    res.redirect("/");
  } catch {
    res.status(401).send("Sign-in link expired or invalid. Return to LimeHQ and try again.");
  }
});

// Redirect any direct login attempts to LimeHQ — it's the single front door.
authRoutes.get("/auth/login", (_req, res) => {
  const env = loadEnv();
  res.redirect(`${env.LIMEHQ_URL}/auth/handoff?app=late_rent_notices`);
});

authRoutes.post("/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME);
  res.status(204).end();
});
