import { Router } from "express";
import { jwtVerify } from "jose";
import { loadEnv } from "../config/env.js";
import { createSessionCookieValue, sessionCookieOptions, SESSION_COOKIE_NAME } from "../auth/session.js";
import { asyncHandler } from "../lib/asyncHandler.js";

export const authRoutes = Router();

// Accepts a short-lived handoff token from LimeHQ and issues a Limona session.
// LimeHQ POSTs the token via a hidden form (BLOCKER 4) so it never appears in
// server logs or the browser URL bar.
//
// The LimeHQ handoff token carries the user's LimeHQ userId and email — all
// identity comes from LimeHQ. Limona no longer maintains its own users table.
// NOTE(users-table): Limona's local users table has been dropped via migration
// 0009_drop_users.ts. Any Limona-local user rows need to be re-provisioned as
// staff accounts in LimeHQ.
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

    // userId, email, name, and the real limona.* permission list all come
    // directly from the LimeHQ handoff JWT. No local users table lookup —
    // Limona's users table has been dropped.
    const limehqUserId = String(payload.userId);
    const email = payload.email as string;
    const name = (payload.name as string) || "";
    const permissions = Array.isArray(payload.permissions) ? (payload.permissions as string[]) : [];

    if (!limehqUserId || !email) {
      res.status(400).send("Invalid sign-in token payload.");
      return;
    }

    const cookieValue = createSessionCookieValue(limehqUserId, email, name, permissions);
    res.cookie(SESSION_COOKIE_NAME, cookieValue, sessionCookieOptions(env));
    res.redirect("/dashboard.html");
  } catch {
    res.status(401).send("Sign-in link expired or invalid. Return to LimeHQ and try again.");
  }
}));

// Redirect any direct login attempts to LimeHQ — it's the only login path.
// The local /api/auth/login endpoint has been removed (BLOCKER 3).
authRoutes.get("/auth/login", (_req, res) => {
  const env = loadEnv();
  res.redirect(`${env.LIMEHQ_URL}/auth/handoff?app=limona`);
});

authRoutes.post("/api/auth/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME);
  res.json({ ok: true });
});

authRoutes.get("/api/auth/me", (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: "Not logged in." });
    return;
  }
  const env = loadEnv();
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      permissions: req.user.permissions,
      limehqUrl: env.LIMEHQ_URL,
    },
  });
});

// NOTE: The invite redemption flow is no longer supported — staff log in
// through LimeHQ only. These stubs return 410 so existing unredeemed invite
// links show a clear error instead of a 404.
authRoutes.post("/api/auth/redeem-invite", (_req, res) => {
  res.status(410).json({
    error: "Invite redemption is no longer supported. Please contact Jason to get access through LimeHQ.",
  });
});

authRoutes.get("/api/auth/invite/:token", (_req, res) => {
  res.status(410).json({
    error: "Invite links are no longer supported. Please contact Jason to get access through LimeHQ.",
  });
});
