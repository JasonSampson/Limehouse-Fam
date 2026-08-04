import { Router } from "express";
import { withPmScope } from "../db/withPmScope.js";
import { requireSession, type AuthedRequest } from "./requireSession.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { loadEnv } from "../config/env.js";

export const meRoutes = Router();
meRoutes.use(requireSession);

// Frontend-only need: the dashboard has to know the signed-in user's role
// and display name to decide what to render (e.g. hide the contact-log form
// from a plain PM, hide every action button from bookkeeping). This does
// not grant anything new — it reads the same pm_users row withPmScope
// already reads on every request, and returns only display-safe fields.
// It does NOT return isFallbackDecisionMaker-granting power, just whether
// the flag is set, so the UI can decide whether to show the fallback panel.
meRoutes.get("/api/me", asyncHandler(async (req: AuthedRequest, res) => {
  const session = req.session!;
  const env = loadEnv();
  const me = await withPmScope(session.pmUserId, async (client) => {
    const result = await client.query<{ display_name: string; role: string; is_fallback_decision_maker: boolean }>(
      "SELECT display_name, role, is_fallback_decision_maker FROM pm_users WHERE id = $1",
      [session.pmUserId]
    );
    return result.rows[0];
  });

  res.json({
    pmUserId: session.pmUserId,
    email: session.email,
    displayName: me?.display_name ?? session.email,
    role: me?.role ?? "pm",
    isFallbackDecisionMaker: me?.is_fallback_decision_maker ?? false,
    shadowMode: env.SHADOW_MODE,
    limehqUrl: env.LIMEHQ_URL,
  });
}));
