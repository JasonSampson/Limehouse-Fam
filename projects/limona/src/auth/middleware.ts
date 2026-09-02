import type { NextFunction, Request, Response } from "express";
import { verifySessionCookieValue, SESSION_COOKIE_NAME } from "./session.js";

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  permissions: string[];
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
// CHANGED [today]: every LimeHQ-authenticated user used to be hardcoded here
// as role: "admin" — the comment used to justify this as "LimeHQ already
// controls who can reach Limona via limona.chat.access," which is true for
// getting in at all, but Limona has two further, real, owner/Admin-only
// permissions (limona.documents.manage, limona.answers.contribute) that this
// hardcoding silently made available to every single staff member regardless
// of what LimeHQ actually granted them — a real bug, found 2026-09-02 when
// Lea (invoices@limehousepm.com, the first non-owner hire with Limona
// access) could see "Upload Document" despite not being Admin. permissions
// now carries the real granted list straight from the LimeHQ handoff token.
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const payload = verifySessionCookieValue(req.cookies?.[SESSION_COOKIE_NAME]);
  if (!payload) return next();

  req.user = {
    id: payload.userId,
    email: payload.email,
    name: payload.name || nameFromEmail(payload.email),
    permissions: payload.permissions,
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

// Replaces the old requireAdmin — every admin-only route now names the one
// specific permission it needs rather than a single collapsed "admin" flag,
// same pattern as Dashboard's requirePermission(key).
export function requirePermission(key: string) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ error: "Not logged in." });
      return;
    }
    if (!req.user.permissions.includes(key)) {
      res.status(403).json({ error: "You don't have permission to do this." });
      return;
    }
    next();
  };
}
