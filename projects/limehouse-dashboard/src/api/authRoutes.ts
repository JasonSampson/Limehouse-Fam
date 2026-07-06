import { Router } from "express";
import { generatePkcePair, generateState } from "../auth/pkce.js";
import { buildAuthorizeUrl, exchangeCodeForToken, verifyIdToken } from "../auth/entra.js";
import { issueSession, clearSession, requireLogin, type AuthedRequest } from "../auth/session.js";
import { resolveLogin } from "../auth/loginResolver.js";
import { logError, logWarn } from "../lib/logger.js";

export const authRoutes = Router();

// PKCE verifier/state travel in a short-lived, httpOnly cookie scoped to the
// auth flow only — never stored server-side.
authRoutes.get("/auth/login", (req, res) => {
  const { verifier, challenge } = generatePkcePair();
  const state = generateState();

  res.cookie("lh_pkce_verifier", verifier, { httpOnly: true, secure: true, sameSite: "strict", maxAge: 10 * 60 * 1000 });
  res.cookie("lh_oauth_state", state, { httpOnly: true, secure: true, sameSite: "strict", maxAge: 10 * 60 * 1000 });

  res.redirect(buildAuthorizeUrl(state, challenge));
});

authRoutes.get("/auth/callback", async (req, res) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    const expectedState = req.cookies?.lh_oauth_state;
    const verifier = req.cookies?.lh_pkce_verifier;

    if (!code || !state || !verifier || state !== expectedState) {
      res.status(400).send("Invalid or expired login attempt. Please try signing in again.");
      return;
    }

    const { idToken } = await exchangeCodeForToken(code, verifier);
    const identity = await verifyIdToken(idToken);

    const resolution = await resolveLogin(identity);
    res.clearCookie("lh_pkce_verifier");
    res.clearCookie("lh_oauth_state");

    if (resolution.outcome === "rejected") {
      logWarn("unauthorized login attempt", { email: identity.email });
      res.status(403).send("Your account is not authorized to access this dashboard. Contact Jason.");
      return;
    }

    await issueSession(res, { id: resolution.user.id, role: resolution.user.role });
    res.redirect("/");
  } catch (err) {
    logError("auth callback failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).send("Login failed. Please try again or contact Jason.");
  }
});

authRoutes.post("/auth/logout", (req, res) => {
  clearSession(res);
  res.status(204).end();
});

// Frontend-only need: header.js has to know the signed-in user's role to
// decide which nav links to render (Team Performance/CEO View/Manage Staff
// are Admin-only). Session already carries id/role — this just echoes it
// back as JSON.
authRoutes.get("/api/me", requireLogin, (req: AuthedRequest, res) => {
  res.json({ id: req.user!.id, role: req.user!.role });
});
