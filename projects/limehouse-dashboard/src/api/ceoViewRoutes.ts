import { Router } from "express";
import { z } from "zod";
import { getScoredRoles } from "../db/kpiRepository.js";
import { periodToSnapshotLabel, type PeriodKey } from "../kpi/period.js";
import { fetchActiveResidentialUnits, fetchBankAccounts } from "../buildium/client.js";
import { revenuePerUnit } from "../kpi/financialSummary.js";
import { getAllFinancialHistory } from "../db/financialHistory.js";
import { getExcludedPropertyIds } from "../kpi/terminatedProperties.js";
import { ACCOUNTING_BASIS } from "../buildium/financialHistorySync.js";
import { logError } from "../lib/logger.js";
import { requireLogin, requireAdmin } from "../auth/session.js";

export const ceoViewRoutes = Router();

// CEO View is Admin-only (fixed 2026-07-04 — it previously had no gate at
// all, a real bug: its own comment used to claim "not password-gated...
// per project brief," but that brief has changed. Same underlying role
// scoring as Team Performance, different display_group/labels (Neo's
// migration 0002 comment: "Assistant Property Manager" here vs. "Portfolio
// Assistant" under team_performance for the same role).
const periodQuerySchema = z
  .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year"])
  .default("this_quarter");

ceoViewRoutes.get("/api/ceo-view/roles", requireLogin, requireAdmin, async (req, res) => {
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
// month, 2018-01 through the current (still-open) month.
//
// CONFIRMED LIVE 2026-07-05 against Jason's real Buildium account and real
// CEO View numbers (Jan-Jun 2026 monthly + Jul 1-5 2026 partial all matched
// to the penny) — see src/kpi/financialSummary.ts and
// src/buildium/client.ts's fetchGeneralLedgerTotals for the confirmed
// formula. This route no longer calls Buildium directly (the old
// /glentries-based version did, computing 8 years of history live on every
// page load); it now reads from dashboard_financial_history
// (src/db/financialHistory.ts, Neo's migration 0008), which
// POST /api/sync/financial-history (src/api/syncRoutes.ts) populates.
// If that table is empty (sync has never been run), this returns an empty
// months array rather than falling back to a live Buildium call — the CEO
// View frontend already handles "months.length === 0" as a legitimate
// empty/loading state (see public/js/ceo-view.js).
//
// Revenue-per-Unit is computed here at read time (not stored), always
// dividing by TODAY's active unit count — see financialSummary.ts's
// revenuePerUnit doc comment for why.
//
// CHANGED 2026-07-10, per Jason directly: excludes terminated-but-not-yet-
// closed-out properties from the denominator (see
// src/kpi/terminatedProperties.ts) — those units aren't earning anything
// right now, so counting them here understated revenue per door.
ceoViewRoutes.get("/api/ceo-view/income", requireLogin, requireAdmin, async (_req, res) => {
  try {
    const [monthlyHistory, allUnits, excludedPropertyIds] = await Promise.all([
      getAllFinancialHistory(ACCOUNTING_BASIS),
      fetchActiveResidentialUnits(),
      getExcludedPropertyIds(),
    ]);
    const unitCount = allUnits.filter((u) => !excludedPropertyIds.has(String(u.PropertyId))).length;

    const months = monthlyHistory.map((m) => ({
      month: m.month,
      grossIncome: m.grossIncome,
      totalExpenses: m.totalExpenses,
      netIncome: m.netIncome,
      revenuePerUnit: revenuePerUnit({ month: m.month, grossIncome: m.grossIncome, unitCount }),
    }));

    const earliestEntryDate = months.length > 0 ? `${months[0].month}-01` : null;
    const requestedFrom = "2018-01-01";

    res.json({
      requestedFrom,
      requestedTo: new Date().toISOString().slice(0, 10),
      coverage: {
        requestedFrom,
        earliestEntryDate,
        fullyCovered: earliestEntryDate !== null && earliestEntryDate <= requestedFrom,
      },
      months,
    });
  } catch (err) {
    logError("GET /api/ceo-view/income failed", { error: String(err) });
    res.status(502).json({
      error: "Failed to load income data. Try running the financial history sync (POST /api/sync/financial-history).",
    });
  }
});

// ============================================================================
// Account Balances — ADDED 2026-07-26, per Jason directly, for the new CEO
// View top-row tile. Real active bank accounts + balances, same live
// Buildium call already used for Reconciliation Accuracy (src/kpi/
// bookkeeperMetrics.ts) — no new data source, just a different view of it.
// Alphabetical, matching the confirmed vendor order used there.
ceoViewRoutes.get("/api/ceo-view/account-balances", requireLogin, requireAdmin, async (_req, res) => {
  try {
    const accounts = await fetchBankAccounts();
    const rows = accounts
      .filter((a) => a.IsActive)
      .map((a) => ({ accountName: a.Name ?? `Account #${a.Id}`, balance: a.Balance }))
      .sort((a, b) => a.accountName.localeCompare(b.accountName));
    res.json({ accounts: rows, count: rows.length });
  } catch (err) {
    logError("GET /api/ceo-view/account-balances failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load bank account balances from Buildium." });
  }
});
