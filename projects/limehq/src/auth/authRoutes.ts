import { Router } from "express";
import { z } from "zod";
import { getAppPool } from "../db/pool.js";
import { verifyPassword } from "./password.js";
import {
  createSessionToken,
  verifySessionToken,
  createPending2faToken,
  pending2faCookieOptions,
  PENDING_2FA_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "./session.js";
import { getUserWithRole, getEffectivePermissions, hasPermission, hasAnyPermissionWithPrefix } from "./permissions.js";
import { requireSession } from "./requireSession.js";
import { createHandoffToken } from "./handoffToken.js";
import { ApiError } from "../lib/apiError.js";
import { loadEnv } from "../config/env.js";
import { logWarn } from "../lib/appLogger.js";

const router = Router();

// ------------------------------------------------------------------ //
// POST /auth/login                                                     //
// ------------------------------------------------------------------ //

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post("/login", async (req, res, next) => {
  try {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "Invalid request body");
    }

    const email = parsed.data.email.toLowerCase();
    const pool = getAppPool();

    // Step 1 — look up user. Generic 401 for any missing/inactive account so
    // we never reveal whether the email exists in the system.
    const userResult = await pool.query<{
      id: number;
      email: string;
      display_name: string;
      password_hash: string;
      active: boolean;
      failed_login_attempts: number;
      locked_until: Date | null;
      totp_enabled_at: Date | null;
    }>(
      `SELECT id, email, display_name, password_hash, active,
              failed_login_attempts, locked_until, totp_enabled_at
       FROM users
       WHERE email = $1`,
      [email],
    );

    const user = userResult.rows[0];

    if (!user || !user.active) {
      // Same response shape regardless of which condition failed — never
      // reveal whether the email address exists in the system.
      res.status(401).json({ ok: false, error: "Invalid email or password" });
      return;
    }

    // Check account lockout before even attempting the password.
    if (user.locked_until && user.locked_until > new Date()) {
      const secondsRemaining = Math.ceil(
        (user.locked_until.getTime() - Date.now()) / 1000,
      );
      res.status(429).json({
        ok: false,
        error: "Account temporarily locked due to too many failed attempts",
        retryAfterSeconds: secondsRemaining,
      });
      return;
    }

    // Step 1 — verify password.
    const passwordOk = await verifyPassword(parsed.data.password, user.password_hash);

    if (!passwordOk) {
      // Increment failure counter. Lock the account once we hit 5 attempts.
      const newAttempts = user.failed_login_attempts + 1;
      const lockUntil = newAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;

      await pool.query(
        `UPDATE users
         SET failed_login_attempts = $1,
             locked_until          = $2,
             updated_at            = now()
         WHERE id = $3`,
        [newAttempts, lockUntil, user.id],
      );

      logWarn("login: bad password", { userId: user.id, attempts: newAttempts });
      res.status(401).json({ ok: false, error: "Invalid email or password" });
      return;
    }

    // Step 2 — password is correct. Reset the PASSWORD lockout state and
    // record the login, but do NOT touch totp_failed_attempts here — that
    // counter only resets on a correct TOTP code (src/auth/totpRoutes.ts),
    // so a leaked password alone never buys unlimited free code guesses.
    await pool.query(
      `UPDATE users
       SET failed_login_attempts = 0,
           locked_until          = NULL,
           last_login_at         = now(),
           updated_at            = now()
       WHERE id = $1`,
      [user.id],
    );

    // 2FA is mandatory, no exemptions (including Owner) — a real session is
    // never issued directly from a password check. Issue a short-lived
    // pending-2FA token instead and send the browser to whichever TOTP step
    // applies: setup (never enrolled) or code entry (already enrolled).
    const pendingToken = await createPending2faToken(user.id);
    res.cookie(PENDING_2FA_COOKIE_NAME, pendingToken, pending2faCookieOptions());
    res.json({
      ok: true,
      redirect: user.totp_enabled_at ? "/auth/totp" : "/account/totp/setup",
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// POST /auth/logout                                                    //
// ------------------------------------------------------------------ //

router.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ //
// POST /auth/reauth                                                    //
// ------------------------------------------------------------------ //
// Requires an active session. Verifies the password again and re-issues
// the session cookie with a fresh authenticatedAt, which satisfies
// requireFreshReauth.ts in late-rent-notices.

const reauthBodySchema = z.object({
  password: z.string().min(1),
});

router.post("/reauth", requireSession, async (req, res, next) => {
  try {
    const parsed = reauthBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, "Invalid request body");
    }

    const pool = getAppPool();
    const userResult = await pool.query<{ password_hash: string; session_version: number }>(
      `SELECT password_hash, session_version FROM users WHERE id = $1`,
      [req.user.userId],
    );

    const user = userResult.rows[0];
    if (!user) {
      throw new ApiError(401, "Not authenticated");
    }

    const passwordOk = await verifyPassword(parsed.data.password, user.password_hash);
    if (!passwordOk) {
      res.status(401).json({ ok: false, error: "Incorrect password" });
      return;
    }

    // Re-issue the session with a fresh authenticatedAt timestamp (resets
    // the 8-hour absolute cap too, same as a fresh login) and a fresh
    // lastActivityAt. sessionVersion carries forward unchanged — reauth
    // proves the same identity again, it isn't a 2FA reset.
    const now = Date.now();
    const token = await createSessionToken({
      userId: req.user.userId,
      email: req.user.email,
      authenticatedAt: now,
      sessionVersion: user.session_version,
      lastActivityAt: now,
    });

    res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// GET /auth/me                                                         //
// ------------------------------------------------------------------ //

router.get("/me", requireSession, async (req, res, next) => {
  try {
    const pool = getAppPool();

    const userResult = await pool.query<{
      id: number;
      email: string;
      display_name: string;
      role_id: number;
      role_name: string;
    }>(
      `SELECT u.id, u.email, u.display_name,
              rt.id AS role_id, rt.name AS role_name
       FROM users u
       JOIN role_templates rt ON rt.id = u.role_template_id
       WHERE u.id = $1`,
      [req.user.userId],
    );

    const user = userResult.rows[0];
    if (!user) {
      throw new ApiError(401, "Not authenticated");
    }

    const permissions = await getEffectivePermissions(req.user.userId);

    res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: { id: user.role_id, name: user.role_name },
      permissions,
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// GET /auth/handoff?app=<name>                                         //
// ------------------------------------------------------------------ //

const KNOWN_APPS: Record<string, (env: ReturnType<typeof loadEnv>) => string | undefined> = {
  late_rent_notices: (env) => env.LATE_RENT_NOTICES_URL,
  dashboard: (env) => env.DASHBOARD_URL,
  limona: (env) => env.LIMONA_URL,
};

// Same permission keys already used by the launcher (server.ts) to decide
// tile visibility — reused here as the actual access control, not just a
// cosmetic show/hide. Previously /handoff only checked requireSession (i.e.
// "is this any logged-in staff member"), so denying someone an app's
// permission only hid their launcher tile — it never stopped them from
// requesting /auth/handoff?app=<app> directly and getting a fully valid
// login token anyway. Owner bypass needs no special-casing here:
// hasPermission()/hasAnyPermissionWithPrefix() already return true
// unconditionally for system_role_key === "owner".
const APP_PERMISSION_KEYS: Record<string, string> = {
  late_rent_notices: "late_rent_notices.notices.view",
  limona: "limona.chat.access",
};

// Dashboard doesn't gate on one fixed permission — it's six independent
// dashboard.* keys (Financials, Occupancy, Marketing & Showings, Drilldowns,
// CEO View, Team Performance), each unlocking its own section, set on the
// Roles/Staff & Permissions pages like any other permission. Entry only
// requires holding at least one of them; which sections actually render is
// decided by Dashboard itself from the real granted list carried in the
// handoff token below — see getEffectivePermissions' role-baseline +
// personal-override merge for where that list comes from.
const DASHBOARD_PERMISSION_PREFIX = "dashboard.";

// Limona is the opposite shape from Dashboard: entry still gates on the one
// fixed limona.chat.access key (everyone gets it by default — migration
// 0009), but two further keys (limona.documents.manage,
// limona.answers.contribute, both owner/Admin-only by default) control real
// capabilities INSIDE Limona once someone's in. FIXED [today]: Limona used
// to receive no permission data at all and treated every signed-in user as
// its own local "admin" role — see Limona's src/auth/middleware.ts — so
// those two keys existed in the catalog but were never actually enforced.
// Forwarding the real limona.* set here, the same way DASHBOARD_PERMISSION_
// PREFIX already does, lets Limona check the real thing.
const LIMONA_PERMISSION_PREFIX = "limona.";

router.get("/handoff", requireSession, async (req, res, next) => {
  try {
    const app = req.query["app"];
    if (typeof app !== "string" || !(app in KNOWN_APPS)) {
      throw new ApiError(
        400,
        `Unknown app '${String(app)}'. Valid values: ${Object.keys(KNOWN_APPS).join(", ")}`,
      );
    }

    const env = loadEnv();
    const targetBase = KNOWN_APPS[app]!(env);
    if (!targetBase) {
      throw new ApiError(503, `Target URL for '${app}' is not configured`);
    }

    let permissions: string[] = [];
    if (app === "dashboard") {
      const allEffective = await getEffectivePermissions(req.user.userId);
      permissions = allEffective.filter((key) => key.startsWith(DASHBOARD_PERMISSION_PREFIX));
      if (permissions.length === 0) {
        throw new ApiError(403, `You don't have access to ${app}.`);
      }
    } else if (app === "limona") {
      const allowed = await hasPermission(req.user.userId, APP_PERMISSION_KEYS[app]!);
      if (!allowed) {
        throw new ApiError(403, `You don't have access to ${app}.`);
      }
      const allEffective = await getEffectivePermissions(req.user.userId);
      permissions = allEffective.filter((key) => key.startsWith(LIMONA_PERMISSION_PREFIX));
    } else {
      const allowed = await hasPermission(req.user.userId, APP_PERMISSION_KEYS[app]!);
      if (!allowed) {
        throw new ApiError(403, `You don't have access to ${app}.`);
      }
    }

    const token = await createHandoffToken(req.user.userId, req.user.email, req.user.displayName, permissions);
    // POST the token via a hidden form so it never appears in server logs or
    // the browser's URL bar (BLOCKER 4 — handoff token must not be a query param).
    // targetBase comes from our own env config; token is a JWT we just signed —
    // both are safe to interpolate directly into this server-rendered page.
    res.send(`<!doctype html>
<html><head><meta charset="utf-8"/></head>
<body>
<form id="hf" method="POST" action="${targetBase}/auth/limehq-callback">
  <input type="hidden" name="token" value="${token}"/>
</form>
<script src="/js/handoff.js"></script>
</body></html>`);
  } catch (err) {
    next(err);
  }
});

export { router as authRouter };
