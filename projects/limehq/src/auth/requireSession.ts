import type { Request, Response, NextFunction } from "express";
import { verifySessionToken, SESSION_COOKIE_NAME } from "./session.js";
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

export async function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token: string | undefined = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) {
    res.status(401).json({ ok: false, error: "Not authenticated" });
    return;
  }

  let payload;
  try {
    payload = await verifySessionToken(token);
  } catch {
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    res.status(401).json({ ok: false, error: "Invalid or expired session" });
    return;
  }

  const user = await getUserWithRole(payload.userId);
  if (!user || !user.active) {
    logWarn("requireSession: user not found or inactive", { userId: payload.userId });
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    res.status(401).json({ ok: false, error: "Not authenticated" });
    return;
  }

  req.user = {
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    authenticatedAt: payload.authenticatedAt,
    systemRoleKey: user.system_role_key,
  };

  next();
}
