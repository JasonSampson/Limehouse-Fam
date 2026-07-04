import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { loadEnv } from "../config/env.js";
import { createSessionCookieValue, sessionCookieOptions, SESSION_COOKIE_NAME } from "../auth/session.js";

export const authRoutes = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRoutes.post("/api/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }
  const { email, password } = parsed.data;

  const result = await getPool().query(
    "SELECT id, password_hash, status FROM users WHERE email = $1",
    [email.toLowerCase()]
  );
  const row = result.rows[0];

  // Same generic error whether the email doesn't exist, the invite hasn't
  // been redeemed yet (no password_hash), the account is disabled, or the
  // password is wrong — never reveal which case it is to an unauthenticated
  // caller.
  const genericError = "Incorrect email or password, or this account is not active.";

  if (!row || !row.password_hash || row.status !== "active") {
    res.status(401).json({ error: genericError });
    return;
  }

  const passwordMatches = await bcrypt.compare(password, row.password_hash);
  if (!passwordMatches) {
    res.status(401).json({ error: genericError });
    return;
  }

  const env = loadEnv();
  const cookieValue = createSessionCookieValue(row.id);
  res.cookie(SESSION_COOKIE_NAME, cookieValue, sessionCookieOptions(env));
  res.json({ ok: true });
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
  res.json({ user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role } });
});

const redeemInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

// Invite redemption: a staffer follows the single-use link, sets their own
// name/password, and the invite becomes unusable (invite_token_used_at set,
// status -> active). No self-service signup exists outside this flow.
authRoutes.post("/api/auth/redeem-invite", async (req, res) => {
  const parsed = redeemInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }
  const { token, name, password } = parsed.data;

  const result = await getPool().query(
    "SELECT id, invite_token_used_at, status FROM users WHERE invite_token = $1",
    [token]
  );
  const row = result.rows[0];
  if (!row || row.invite_token_used_at || row.status !== "invited") {
    res.status(400).json({ error: "This invite link is invalid or has already been used." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await getPool().query(
    `
    UPDATE users
    SET password_hash = $1, name = $2, status = 'active', invite_token_used_at = now()
    WHERE id = $3
    `,
    [passwordHash, name, row.id]
  );

  res.json({ ok: true });
});

// Lets the invite-redemption page show the invitee's email/name before they
// set a password, without requiring login (they aren't logged in yet).
authRoutes.get("/api/auth/invite/:token", async (req, res) => {
  const result = await getPool().query(
    "SELECT email, name, invite_token_used_at, status FROM users WHERE invite_token = $1",
    [req.params.token]
  );
  const row = result.rows[0];
  if (!row || row.invite_token_used_at || row.status !== "invited") {
    res.status(404).json({ error: "This invite link is invalid or has already been used." });
    return;
  }
  res.json({ email: row.email });
});
