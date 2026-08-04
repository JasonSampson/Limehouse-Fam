import { Router } from "express";
import { withPmScope } from "../db/withPmScope.js";
import { requireSession, type AuthedRequest } from "./requireSession.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { formatUnitDisplay } from "../lib/unitDisplay.js";

export const searchRoutes = Router();
searchRoutes.use(requireSession);

// Finds past notices and contact history by property address/name — the
// dashboard list only ever shows recent/active items (and, per Jason's
// explicit request, hides voided-and-never-sent drafts entirely), so this
// is the only way to look up what happened at a specific address months
// ago. Deliberately shows EVERY status here, including voided — unlike the
// dashboard, a deliberate lookup should show the full history, not just
// what still needs action.
//
// Deliberately NOT filtered on p.is_active: this is a historical/audit
// lookup by design (see above — "months ago"), and a property that's since
// sold or gone inactive in Buildium is exactly the kind of address someone
// would still need to search for. p.is_active is returned alongside each
// result instead, so the UI can label an inactive property's history
// accordingly rather than hiding it.
//
// Same withPmScope/RLS visibility as every other route: a plain PM only
// searches within their own assigned doors, admin_assistant/bookkeeping see
// portfolio-wide, per the existing RLS policies on notices/contact_attempts.
searchRoutes.get("/api/search", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) {
    res.json({ notices: [], contactAttempts: [] });
    return;
  }
  const likePattern = `%${q}%`;

  const results = await withPmScope(session.pmUserId, async (client) => {
    const noticesResult = await client.query(
      `SELECT n.id, n.status, n.amount_due_at_draft, n.days_late_at_draft,
              n.amount_due_at_send, n.drafted_at, n.sent_at, n.delivery_status,
              l.unit_label, p.name AS property_name, p.address_line1, p.is_active AS property_is_active,
              (SELECT count(DISTINCT l2.unit_buildium_id) FROM leases l2 WHERE l2.property_id = l.property_id) > 1 AS multi_unit
       FROM notices n
       JOIN leases l ON l.id = n.lease_id
       JOIN properties p ON p.id = l.property_id
       WHERE p.address_line1 ILIKE $1 OR p.name ILIKE $1
       ORDER BY n.drafted_at DESC
       LIMIT 50`,
      [likePattern]
    );

    const contactAttemptsResult = await client.query(
      `SELECT ca.id, ca.lease_id, ca.contact_method, ca.contact_note, ca.outcome,
              ca.promised_pay_date, ca.occurred_at,
              l.unit_label, p.name AS property_name, p.address_line1, p.is_active AS property_is_active,
              (SELECT count(DISTINCT l2.unit_buildium_id) FROM leases l2 WHERE l2.property_id = l.property_id) > 1 AS multi_unit
       FROM contact_attempts ca
       JOIN leases l ON l.id = ca.lease_id
       JOIN properties p ON p.id = l.property_id
       WHERE p.address_line1 ILIKE $1 OR p.name ILIKE $1
       ORDER BY ca.occurred_at DESC
       LIMIT 50`,
      [likePattern]
    );

    const withUnitDisplay = (r: { unit_label: string; multi_unit: boolean }) => ({
      ...r,
      unit_display: formatUnitDisplay(r.unit_label, r.multi_unit),
    });
    return {
      notices: noticesResult.rows.map(withUnitDisplay),
      contactAttempts: contactAttemptsResult.rows.map(withUnitDisplay),
    };
  });

  res.json(results);
}));
