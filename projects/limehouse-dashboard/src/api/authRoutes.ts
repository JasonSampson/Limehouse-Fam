import { Router } from "express";
import { jwtVerify } from "jose";
import { issueSession, clearSession, requireLogin, type AuthedRequest } from "../auth/session.js";
import { findByEmail, bumpLastLogin } from "../db/staffUsers.js";
import { loadEnv } from "../config/env.js";
import { logError } from "../lib/logger.js";

export const authRoutes = Router();

// Accepts a short-lived handoff token from LimeHQ and issues a dashboard
// session. LimeHQ redirects here after a successful login so staff don't
// need a separate dashboard password.
authRoutes.get("/auth/limehq-callback", async (req, res) => {
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

    const user = await findByEmail(email);
    if (!user || !user.active) {
      res.status(403).send("Your LimeHQ account does not have access to this dashboard. Contact Jason.");
      return;
    }

    await bumpLastLogin(user.id);
    await issueSession(res, { id: user.id, role: user.role });
    res.redirect("/");
  } catch (err) {
    logError("limehq-callback failed", {
      type: err instanceof Error ? err.constructor.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      code: (err as Record<string, unknown>).code ?? null,
      raw: String(err),
    });
    res.status(401).send("Sign-in link expired or invalid. Return to LimeHQ and try again.");
  }
});

// Redirect any direct login attempts to LimeHQ — it's the single front door.
authRoutes.get("/auth/login", (_req, res) => {
  const env = loadEnv();
  res.redirect(`${env.LIMEHQ_URL}/auth/handoff?app=dashboard`);
});

authRoutes.post("/auth/logout", (_req, res) => {
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
