import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requireAdmin } from "../auth/middleware.js";

export const adminUserRoutes = Router();
adminUserRoutes.use(requireAdmin);

adminUserRoutes.get("/api/admin/users", async (_req, res) => {
  const result = await getPool().query(
    `SELECT id, email, name, role, status, created_at FROM users ORDER BY created_at DESC`
  );
  res.json({ users: result.rows });
});

const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

// Admin invites a staffer by email. Creates a row with a single-use
// invite_token and status='invited' — no password yet, so this account
// cannot log in until the staffer redeems the link. The link itself
// (containing the token) is shown to the admin to send to the staffer
// manually (e.g. via Teams/email) — v1 does not auto-send it.
adminUserRoutes.post("/api/admin/users/invite", async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return;
  }
  const { email, name } = parsed.data;

  const existing = await getPool().query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (existing.rows.length > 0) {
    res.status(409).json({ error: "A user with this email already exists." });
    return;
  }

  const inviteToken = crypto.randomBytes(24).toString("hex");
  const result = await getPool().query(
    `
    INSERT INTO users (email, name, role, invite_token, invited_by, status)
    VALUES ($1, $2, 'member', $3, $4, 'invited')
    RETURNING id
    `,
    [email.toLowerCase(), name, inviteToken, req.user!.id]
  );

  res.json({ ok: true, userId: result.rows[0].id, inviteToken });
});

// Disables access without deleting the row, so chat_queries history stays
// intact. Re-enabling (status back to 'active') is a manual follow-up if
// ever needed — not built in v1 since it wasn't asked for.
adminUserRoutes.post("/api/admin/users/:id/disable", async (req, res) => {
  const result = await getPool().query(
    "UPDATE users SET status = 'disabled' WHERE id = $1 AND role != 'admin' RETURNING id",
    [req.params.id]
  );
  if (result.rows.length === 0) {
    res.status(400).json({ error: "User not found, or admins cannot be disabled." });
    return;
  }
  res.json({ ok: true });
});
