import { Router } from "express";
import { z } from "zod";
import { requireLogin, requireAdmin } from "../auth/session.js";
import { listAll, inviteStaff, updateRole, setActive } from "../db/staffUsers.js";
import { logError } from "../lib/logger.js";

export const staffUsersRoutes = Router();

staffUsersRoutes.get("/api/staff-users", requireLogin, requireAdmin, async (_req, res) => {
  try {
    res.json(await listAll());
  } catch (err) {
    logError("GET /api/staff-users failed", { error: String(err) });
    res.status(500).json({ error: "Failed to load staff list." });
  }
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "staff"]),
});

staffUsersRoutes.post("/api/staff-users", requireLogin, requireAdmin, async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Valid email and role ('admin' or 'staff') are required." });
    return;
  }
  try {
    const staff = await inviteStaff(parsed.data);
    res.status(201).json(staff);
  } catch (err) {
    // Unique violation on lower(email) — the most likely real-world cause,
    // surfaced as a plain 409 rather than a generic 500.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("uq_staff_users_email_lower")) {
      res.status(409).json({ error: "A staff account with that email already exists." });
      return;
    }
    logError("POST /api/staff-users failed", { error: message });
    res.status(500).json({ error: "Failed to invite staff member." });
  }
});

const updateSchema = z
  .object({
    role: z.enum(["admin", "staff"]).optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => data.role !== undefined || data.active !== undefined, {
    message: "At least one of role or active must be provided.",
  });

staffUsersRoutes.patch("/api/staff-users/:id", requireLogin, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid staff user id." });
    return;
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request body." });
    return;
  }

  try {
    let updated = null;
    if (parsed.data.role !== undefined) {
      updated = await updateRole(id, parsed.data.role);
    }
    if (parsed.data.active !== undefined) {
      updated = await setActive(id, parsed.data.active);
    }
    res.json(updated);
  } catch (err) {
    logError("PATCH /api/staff-users/:id failed", { error: String(err), id });
    res.status(500).json({ error: "Failed to update staff member." });
  }
});
