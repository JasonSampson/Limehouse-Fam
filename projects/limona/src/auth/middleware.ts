import type { NextFunction, Request, Response } from "express";
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

// Derives a display name from an email address when no name is stored.
// Used because the LimeHQ handoff token only carries userId and email.
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .replace(/[._-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Attaches req.user from the session cookie without a DB round-trip.
// All identity (userId, email) comes from the LimeHQ handoff token stored
// in the signed session cookie. Limona no longer has its own users table.
//
// All LimeHQ-authenticated users are treated as "admin" in Limona — LimeHQ
// already controls who can reach Limona via the limona.chat.access permission.
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const payload = verifySessionCookieValue(req.cookies?.[SESSION_COOKIE_NAME]);
  if (!payload) return next();

  req.user = {
    id: payload.userId,
    email: payload.email,
    name: payload.name || nameFromEmail(payload.email),
    role: "admin",
    status: "active",
  };
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
