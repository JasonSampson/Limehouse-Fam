import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { loadEnv } from "../config/env.js";

// Signs/verifies the "Team Performance unlocked" cookie. No per-user
// accounts — one shared password for the whole tab (per project brief), so
// this is a single boolean flag in a signed cookie, not a session store or
// JWT library. Signed (HMAC) so a client can't forge "unlocked=true"
// without knowing SESSION_COOKIE_SECRET.
const COOKIE_NAME = "tp_unlocked";

function sign(value: string): string {
  const env = loadEnv();
  const mac = createHmac("sha256", env.SESSION_COOKIE_SECRET).update(value).digest("hex");
  return `${value}.${mac}`;
}

function verify(signed: string | undefined): boolean {
  if (!signed) return false;
  const [value, mac] = signed.split(".");
  if (!value || !mac) return false;
  const env = loadEnv();
  const expectedMac = createHmac("sha256", env.SESSION_COOKIE_SECRET).update(value).digest("hex");
  const macBuf = Buffer.from(mac);
  const expectedBuf = Buffer.from(expectedMac);
  if (macBuf.length !== expectedBuf.length) return false;
  return value === "unlocked" && timingSafeEqual(macBuf, expectedBuf);
}

export function issueUnlockedCookie(res: Response): void {
  const env = loadEnv();
  res.cookie(COOKIE_NAME, sign("unlocked"), {
    httpOnly: true,
    sameSite: "strict",
    secure: env.NODE_ENV === "production",
    maxAge: 8 * 60 * 60 * 1000, // 8 hours — long enough for a workday, not indefinite
  });
}

export function requireTeamPerformanceUnlocked(req: Request, res: Response, next: NextFunction): void {
  if (verify(req.cookies?.[COOKIE_NAME])) {
    next();
    return;
  }
  res.status(401).json({ error: "Team Performance tab is locked. Enter the shared password to continue." });
}
