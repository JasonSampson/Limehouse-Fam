import type { NextFunction, Request, Response } from "express";
import { getPool } from "../db/pool.js";
import { verifySessionCookieValue, SESSION_COOKIE_NAME } from "./session.js";

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  status: "invited" | "active" | "disabled";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

// Loads the user for any request that has a valid session cookie, whether
// or not the route actually requires auth. Mounted once at app setup so
// req.user is available everywhere downstream.
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const payload = verifySessionCookieValue(req.cookies?.[SESSION_COOKIE_NAME]);
  if (!payload) return next();

  const result = await getPool().query(
    "SELECT id, email, name, role, status FROM users WHERE id = $1",
    [payload.userId]
  );
  const row = result.rows[0];
  // A disabled user's cookie may still be validly signed and unexpired —
  // status is re-checked on every request so revoking access takes effect
  // immediately rather than waiting for the session to expire.
  if (row && row.status !== "disabled") {
    req.user = row as AuthedUser;
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Not logged in." });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Not logged in." });
    return;
  }
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Admin access only." });
    return;
  }
  next();
}
