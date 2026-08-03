import type { Request, Response, NextFunction } from "express";
import {
  verifySessionToken,
  createSessionToken,
  sessionCookieOptions,
  isIdleExpired,
  SESSION_COOKIE_NAME,
} from "./session.js";
import { getUserWithRole } from "./permissions.js";
import { logWarn } from "../lib/appLogger.js";

declare global {
  namespace Express {
    interface Request {
      user: {
        userId: number;
        email: string;
        displayName: string;
        authenticatedAt: number;
        systemRoleKey: string | null;
      };
    }
  }
}

// Browsers tag every request with how it was initiated. A real page load —
// typing the URL, clicking a link, hitting refresh, or a plain <form>
// submit — is always "navigate", set by the browser itself and not
// something client-side JS can override by setting an Accept header. A
// fetch() call from our own page scripts (Map's data loads, login.js, etc.)
// is "cors" or "same-origin", never "navigate". This lets a single check
// send a human refreshing a stale page back to the sign-in screen, while
// leaving JSON responses intact for JS that already handles a 401 itself.
function isPageNavigation(req: Request): boolean {
  return req.headers["sec-fetch-mode"] === "navigate";
}

function respondUnauthenticated(req: Request, res: Response, message: string): void {
  if (isPageNavigation(req)) {
    res.redirect(302, "/");
    return;
  }
  res.status(401).json({ ok: false, error: message });
}

export async function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token: string | undefined = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) {
    respondUnauthenticated(req, res, "Not authenticated");
    return;
  }

  let payload;
  try {
    payload = await verifySessionToken(token);
  } catch {
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    respondUnauthenticated(req, res, "Invalid or expired session");
    return;
  }

  // 30-minute inactivity timeout, independent of (and always tighter than
  // or equal to) the 8-hour absolute cap already enforced by the JWT's own
  // expiry — see session.ts's createSessionToken comment for why that
  // expiry is pinned to authenticatedAt rather than refreshed here.
  if (isIdleExpired(payload.lastActivityAt)) {
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    respondUnauthenticated(req, res, "Invalid or expired session");
    return;
  }

  const user = await getUserWithRole(payload.userId);
  if (!user || !user.active) {
    logWarn("requireSession: user not found or inactive", { userId: payload.userId });
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    respondUnauthenticated(req, res, "Not authenticated");
    return;
  }

  // A mismatch means this user's 2FA was force-reset (staff "lost my
  // phone" reset, or Owner email recovery) after this token was issued —
  // the JWT is still cryptographically valid and unexpired, but the reset
  // must invalidate it anyway. Treated identically to an expired session.
  if (user.session_version !== payload.sessionVersion) {
    logWarn("requireSession: session_version mismatch, forcing re-login", {
      userId: payload.userId,
    });
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    respondUnauthenticated(req, res, "Invalid or expired session");
    return;
  }

  req.user = {
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    authenticatedAt: payload.authenticatedAt,
    systemRoleKey: user.system_role_key,
  };

  // Refresh the idle-activity clock on every authenticated request. This
  // does NOT extend the 8-hour absolute cap — createSessionToken pins the
  // JWT's expiry to the original authenticatedAt, not to "now."
  const refreshedToken = await createSessionToken({
    userId: user.id,
    email: user.email,
    authenticatedAt: payload.authenticatedAt,
    sessionVersion: payload.sessionVersion,
    lastActivityAt: Date.now(),
  });
  res.cookie(SESSION_COOKIE_NAME, refreshedToken, sessionCookieOptions());

  next();
}
