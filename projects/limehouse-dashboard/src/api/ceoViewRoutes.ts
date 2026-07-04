import { Router } from "express";
import { z } from "zod";
import { getScoredRoles } from "../db/kpiRepository.js";
import { periodToSnapshotLabel, type PeriodKey } from "../kpi/period.js";
import { fetchGlEntries, fetchGlAccountsById, fetchProperties, fetchUnitsForProperty } from "../buildium/client.js";
import { summarizeMonthlyFinancials, revenuePerUnit, checkGlHistoryCoverage } from "../kpi/financialSummary.js";
import { logError } from "../lib/logger.js";

export const ceoViewRoutes = Router();

// CEO View is NOT password-gated (only Team Performance is, per project
// brief) — same underlying role scoring, different display_group/labels
// (Neo's migration 0002 comment: "Assistant Property Manager" here vs.
// "Portfolio Assistant" under team_performance for the same role).
const periodQuerySchema = z
  .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year"])
  .default("this_quarter");

ceoViewRoutes.get("/api/ceo-view/roles", async (req, res) => {
  const parsed = periodQuerySchema.safeParse(req.query.period);
  const period: PeriodKey = parsed.success ? parsed.data : "this_quarter";
  const snapshotLabel = periodToSnapshotLabel(period);
  try {
    const roles = await getScoredRoles(snapshotLabel, "ceo_view");
    res.json({ period: snapshotLabel, roles });
  } catch (err) {
    logError("GET /api/ceo-view/roles failed", { error: String(err) });
    res.status(500).json({ error: "Failed to load CEO View data." });
  }
});

// ============================================================================
// CEO View income charts: Gross Income / Net Income / Revenue-per-Unit by
// month, requested range 2018-01 through today (per project brief).
//
// STATUS: route exists and returns a well-formed response shape now, so
// Tron can wire up the UI. The underlying numbers are UNVERIFIED — this
// project has no live Buildium credentials yet (see project brief and the
// research notes on fetchGlEntries in src/buildium/client.ts). Two
// specific things that can only be confirmed once a real key exists:
//   1. Whether Buildium's /glentries endpoint's actual field names/casing
//      match this schema at all (it may 404, or return a different shape).
//   2. Whether GL history actually reaches back to 2018 for this account —
//      the response always includes a `coverage` field so the frontend
//      can show an honest "data starts at X" message instead of a chart
//      that silently implies more history exists than it does.
// If fetchGlEntries throws (wrong endpoint, wrong auth, etc.) this route
// returns a 502 with a clear "not yet verified" message rather than a
// generic crash, so Tron's UI has something concrete to render for the
// not-yet-working state.
const DEFAULT_FROM_DATE = "2018-01-01";

const incomeQuerySchema = z.object({
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(DEFAULT_FROM_DATE),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

ceoViewRoutes.get("/api/ceo-view/income", async (req, res) => {
  const parsed = incomeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid fromDate/toDate query params (expected YYYY-MM-DD)." });
    return;
  }
  const fromDate = parsed.data.fromDate;
  const toDate = parsed.data.toDate ?? new Date().toISOString().slice(0, 10);

  try {
    const [entries, glAccountsById, properties] = await Promise.all([
      fetchGlEntries(fromDate, toDate),
      fetchGlAccountsById(),
      fetchProperties(),
    ]);

    const unitLists = await Promise.all(properties.map((p) => fetchUnitsForProperty(String(p.Id))));
    const unitCount = unitLists.reduce((sum, units) => sum + units.length, 0);

    const monthly = summarizeMonthlyFinancials(entries, glAccountsById);
    const withRevenuePerUnit = monthly.map((m) => ({
      ...m,
      revenuePerUnit: revenuePerUnit({ month: m.month, grossIncome: m.grossIncome, unitCount }),
    }));

    const coverage = checkGlHistoryCoverage(entries, fromDate);

    res.json({
      requestedFrom: fromDate,
      requestedTo: toDate,
      coverage,
      months: withRevenuePerUnit,
      unverified: true, // see route comment above — not yet confirmed against a live Buildium response
    });
  } catch (err) {
    logError("GET /api/ceo-view/income failed", { error: String(err) });
    res.status(502).json({
      error:
        "Failed to load income data from Buildium. This endpoint's underlying GL query is not yet verified against a live account — see server logs for the specific failure.",
    });
  }
});
