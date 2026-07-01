import type { Request, Response, NextFunction } from "express";
import { verifySessionToken, SESSION_COOKIE_NAME, type SessionPayload } from "../auth/session.js";

export interface AuthedRequest extends Request {
  session?: SessionPayload;
}

export async function requireSession(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  try {
    req.session = await verifySessionToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Session expired or invalid. Please sign in again." });
  }
}
