import { Router } from "express";
import { generatePkcePair, generateState } from "../auth/pkce.js";
import { buildAuthorizeUrl, exchangeCodeForToken, verifyIdToken } from "../auth/entra.js";
import { createSessionToken, SESSION_COOKIE_NAME, sessionCookieOptions } from "../auth/session.js";
import { getAppPool } from "../db/pool.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace } from "../lib/trace.js";

export const authRoutes = Router();

// PKCE verifier/state are held in a short-lived, httpOnly cookie scoped to
// the auth flow only — never logged, never stored server-side in a table.
authRoutes.get("/auth/login", (req, res) => {
  const { verifier, challenge } = generatePkcePair();
  const state = generateState();

  res.cookie("lrn_pkce_verifier", verifier, { httpOnly: true, secure: true, sameSite: "strict", maxAge: 10 * 60 * 1000 });
  res.cookie("lrn_oauth_state", state, { httpOnly: true, secure: true, sameSite: "strict", maxAge: 10 * 60 * 1000 });

  res.redirect(buildAuthorizeUrl(state, challenge));
});

authRoutes.get("/auth/callback", async (req, res) => {
  const trace = startTrace();
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    const expectedState = req.cookies?.lrn_oauth_state;
    const verifier = req.cookies?.lrn_pkce_verifier;

    if (!code || !state || !verifier || state !== expectedState) {
      res.status(400).send("Invalid or expired login attempt. Please try signing in again.");
      return;
    }

    const { idToken } = await exchangeCodeForToken(code, verifier);
    const identity = await verifyIdToken(idToken);

    const pool = getAppPool();
    const pmResult = await pool.query<{ id: number; is_fallback_decision_maker: boolean; active: boolean }>(
      "SELECT id, is_fallback_decision_maker, active FROM pm_users WHERE entra_object_id = $1",
      [identity.entraObjectId]
    );

    if (pmResult.rows.length === 0 || !pmResult.rows[0].active) {
      console.error("unauthorized login attempt", { entraObjectId: identity.entraObjectId, email: identity.email });
      res.status(403).send("Your account is not authorized to access this dashboard. Contact Jason.");
      return;
    }

    const pm = pmResult.rows[0];
    const sessionToken = await createSessionToken({
      pmUserId: pm.id,
      email: identity.email,
      isFallbackDecisionMaker: pm.is_fallback_decision_maker,
      authenticatedAt: Date.now(),
    });

    res.clearCookie("lrn_pkce_verifier");
    res.clearCookie("lrn_oauth_state");
    res.cookie(SESSION_COOKIE_NAME, sessionToken, sessionCookieOptions);

    await writeAuditLog(pool, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      actorType: pm.is_fallback_decision_maker ? "fallback_decision_maker" : "pm",
      actorId: String(pm.id),
      eventType: "auth.login",
      eventSummary: `PM ${pm.id} logged in via Entra.`,
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
  } catch (err) {
    const cause = err instanceof Error && err.cause ? err.cause : undefined;
    console.error(
      "auth callback failed",
      err instanceof Error ? err.message : err,
      cause ? { cause } : ""
    );
    res.status(500).send("Login failed. Please try again or contact Jason.");
  }
});

authRoutes.post("/auth/logout", (req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME);
  res.status(204).end();
});
