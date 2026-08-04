import { Router } from "express";
import { z } from "zod";
import { withPmScope } from "../db/withPmScope.js";
import { requireSession, type AuthedRequest } from "./requireSession.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { writeAuditLog } from "../lib/auditLog.js";
import { startTrace } from "../lib/trace.js";

export const pmAssignmentRoutes = Router();
pmAssignmentRoutes.use(requireSession);

// Active property managers, for the "assign a PM" dropdown on the
// dashboard. pm_users has no RLS (every signed-in session already needs to
// resolve display names for notices/audit context), so this is a plain read.
pmAssignmentRoutes.get("/api/pm-users", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const pmUsers = await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query(
      "SELECT id, display_name, role FROM pm_users WHERE active = true AND role = 'pm' ORDER BY display_name"
    );
    return result.rows;
  });
  res.json({ pmUsers });
}));

const createAssignmentSchema = z.object({
  propertyId: z.number().int().positive(),
  pmUserId: z.number().int().positive(),
});

// INSERT-only, by design — see migration 0043's comment. This route must
// never gain an UPDATE or DELETE sibling: pm_property_assignments has no
// RLS, and a property with zero assignment rows is deliberately visible to
// every signed-in PM (so genuinely delinquent tenants on a newly-added or
// not-yet-assigned property don't sit invisible — see migration 0043). If
// removing/reassigning an existing row were exposed here too, any signed-in
// session could empty out an already-scoped property's assignments and
// accidentally flip it into that same portfolio-wide-visible bucket.
// Filling an empty slot carries no such risk — it only ever narrows
// visibility back down for that property, never widens it.
pmAssignmentRoutes.post("/api/pm-property-assignments", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const parsed = createAssignmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A property and a property manager are required.", details: parsed.error.flatten() });
    return;
  }

  const inserted = await withPmScope(session.pmUserId, async (client) => {
    // is_active check added alongside migration 0045: assigning a PM to a
    // property that's sold/inactive in Buildium is exactly the mistake that
    // produced 123 bad rows in this table on 2026-07-17 (a bulk-assign that
    // predated properties.is_active existing at all) — block it at the
    // source instead of relying on downstream filters to make it harmless.
    const property = await client.query<{ is_active: boolean }>("SELECT is_active FROM properties WHERE id = $1", [
      parsed.data.propertyId,
    ]);
    if (property.rows.length === 0 || property.rows[0].is_active === false) {
      return { inactiveProperty: true as const };
    }

    const existing = await client.query("SELECT id FROM pm_property_assignments WHERE property_id = $1", [
      parsed.data.propertyId,
    ]);
    if (existing.rows.length > 0) {
      return { alreadyAssigned: true as const };
    }

    const result = await client.query<{ id: number }>(
      `INSERT INTO pm_property_assignments (pm_user_id, property_id, source, synced_at)
       VALUES ($1, $2, 'manual_app_assignment', now())
       RETURNING id`,
      [parsed.data.pmUserId, parsed.data.propertyId]
    );

    const trace = startTrace();
    await writeAuditLog(client, {
      companyId: "limehouse-pm",
      instanceId: "late-rent-notices",
      actorType: "pm",
      actorId: String(session.pmUserId),
      eventType: "pm_property_assignment.created",
      eventSummary: `PM ${session.pmUserId} assigned property ${parsed.data.propertyId} to PM ${parsed.data.pmUserId}.`,
      eventData: { propertyId: parsed.data.propertyId, pmUserId: parsed.data.pmUserId },
      contextSnapshot: { propertyId: parsed.data.propertyId },
      privacyCategory: "N/A",
      regulationTags: [],
      riskLevel: "low",
      propertyId: parsed.data.propertyId,
      legalBasis: "portfolio_management_assignment",
      retentionPolicy: "retain_7_years_post_tenancy",
      trace,
    });

    return { id: result.rows[0].id };
  });

  if ("inactiveProperty" in inserted) {
    res.status(409).json({ error: "This property is inactive (sold or off management) and can't be assigned a property manager." });
    return;
  }

  if ("alreadyAssigned" in inserted) {
    res.status(409).json({ error: "This property already has a property manager assigned." });
    return;
  }

  res.status(201).json(inserted);
}));
