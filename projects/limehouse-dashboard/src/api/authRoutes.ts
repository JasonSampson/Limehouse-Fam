import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { jwtVerify } from "jose";
import { issueSession, clearSession, requireLogin, type AuthedRequest } from "../auth/session.js";
import { loadEnv } from "../config/env.js";
import { logError } from "../lib/logger.js";

export const authRoutes = Router();

// Accepts a short-lived handoff token from LimeHQ and issues a dashboard
// session. LimeHQ redirects here after a successful login so staff don't
// need a separate dashboard password.
//
// CHANGED [today]: this used to look the signed-in email up in Dashboard's
// own local staff_users table and reject anyone without an active row there
// — a table only ever populated by Dashboard's now-removed "Manage Staff"
// page (see migrations/0007_drop_team_performance_password.ts's era). Staff
// accounts and access have been managed centrally in LimeHQ for a while, but
// nothing was ever built to keep that local table in sync, so a real new
// hire granted Dashboard access in LimeHQ (Lea, invoices@limehousepm.com,
// [today]) had no row here and was rejected outright even though LimeHQ
// correctly believed she had access. Trusting the token's own permissions
// list directly — signed by LimeHQ, which just verified the grant against
// the real Roles/Staff & Permissions data — removes the local table from
// this decision entirely; there is nothing left here to fall out of sync.
authRoutes.post("/auth/limehq-callback", asyncHandler(async (req, res) => {
  const token = req.body.token;
  if (typeof token !== "string") {
    res.status(400).send("Invalid sign-in link.");
    return;
  }
  try {
    const env = loadEnv();
    const secret = new TextEncoder().encode(env.LIMEHQ_HANDOFF_SECRET);
    const { payload } = await jwtVerify(token, secret);
    const userId = payload.userId as number;
    const permissions = Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [];

    // LimeHQ's own /auth/handoff already refuses to issue a token at all
    // unless the person holds at least one dashboard.* permission — this is
    // a defense-in-depth restatement of that same rule, not the primary
    // gate. See permissions.ts's DASHBOARD_PERMISSION_PREFIX on the LimeHQ
    // side.
    if (permissions.length === 0) {
      res.status(403).send("Your LimeHQ account does not have access to this dashboard. Contact your Limehouse administrator.");
      return;
    }

    await issueSession(res, { id: userId, permissions });
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
}));

// Redirect any direct login attempts to LimeHQ — it's the single front door.
authRoutes.get("/auth/login", (_req, res) => {
  const env = loadEnv();
  res.redirect(`${env.LIMEHQ_URL}/auth/handoff?app=dashboard`);
});

authRoutes.post("/auth/logout", (_req, res) => {
  clearSession(res);
  res.status(204).end();
});

// Frontend-only need: header.js has to know which of the six dashboard.*
// permissions the signed-in user actually holds, to decide which nav links
// to render (e.g. Team Performance/CEO View links only show for someone who
// holds those specific keys). Session already carries the full list.
authRoutes.get("/api/me", requireLogin, (req: AuthedRequest, res) => {
  const env = loadEnv();
  res.json({ id: req.user!.id, permissions: req.user!.permissions, limehqUrl: env.LIMEHQ_URL });
});
