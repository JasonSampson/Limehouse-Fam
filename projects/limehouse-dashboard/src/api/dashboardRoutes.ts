import { Router } from "express";
import { z } from "zod";
import {
  fetchOutstandingBalances,
  fetchProperties,
  fetchUnitsForProperty,
  fetchLeasesByStatus,
  fetchOwners,
  fetchLeaseTransactions,
} from "../buildium/client.js";
import {
  summarizeDelinquency,
  delinquentLeaseRows,
  bucketDelinquencyByAge,
  daysLateAsOf,
} from "../buildium/delinquency.js";
import { summarizeOccupancy, summarizeLeaseMix, upcomingRenewals } from "../kpi/occupancy.js";
import { resolvePeriod, type PeriodKey } from "../kpi/period.js";
import {
  summarizeRentAndDeposit,
  summarizeMonthlyCollectionRates,
  earliestPaymentPerMonth,
} from "../kpi/rentCollection.js";
import { logError } from "../lib/logger.js";

export const dashboardRoutes = Router();

const periodSchema = z
  .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year"])
  .default("this_month");

// ============================================================================
// STRUCTURAL tiles — always as-of-today, period param is intentionally
// ignored if a caller sends one, per the brief's flow-vs-structural rule.
// ============================================================================

dashboardRoutes.get("/api/dashboard/occupancy", async (_req, res) => {
  try {
    const properties = await fetchProperties();
    const unitLists = await Promise.all(properties.map((p) => fetchUnitsForProperty(String(p.Id))));
    const totalUnits = unitLists.reduce((sum, units) => sum + units.length, 0);
    const activeLeases = await fetchLeasesByStatus(["Active"]);
    res.json(summarizeOccupancy(totalUnits, activeLeases));
  } catch (err) {
    logError("GET /api/dashboard/occupancy failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load occupancy data from Buildium." });
  }
});

dashboardRoutes.get("/api/dashboard/lease-mix", async (_req, res) => {
  try {
    const activeLeases = await fetchLeasesByStatus(["Active"]);
    res.json(summarizeLeaseMix(activeLeases));
  } catch (err) {
    logError("GET /api/dashboard/lease-mix failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load lease mix data from Buildium." });
  }
});

dashboardRoutes.get("/api/dashboard/delinquency", async (_req, res) => {
  try {
    const balances = await fetchOutstandingBalances();
    res.json(summarizeDelinquency(balances));
  } catch (err) {
    logError("GET /api/dashboard/delinquency failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load delinquency data from Buildium." });
  }
});

// Drill-down: property/unit/balance, sorted highest balance first.
dashboardRoutes.get("/api/dashboard/delinquency/leases", async (_req, res) => {
  try {
    const balances = await fetchOutstandingBalances();
    res.json(delinquentLeaseRows(balances));
  } catch (err) {
    logError("GET /api/dashboard/delinquency/leases failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load delinquent lease list from Buildium." });
  }
});

const renewalsQuerySchema = z.object({
  withinDays: z.coerce.number().int().positive().max(365).default(60),
});

dashboardRoutes.get("/api/dashboard/renewals", async (req, res) => {
  const parsed = renewalsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid withinDays query param." });
    return;
  }
  try {
    const activeLeases = await fetchLeasesByStatus(["Active"]);
    res.json(upcomingRenewals(activeLeases, new Date(), parsed.data.withinDays));
  } catch (err) {
    logError("GET /api/dashboard/renewals failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load renewal data from Buildium." });
  }
});

dashboardRoutes.get("/api/dashboard/properties", async (_req, res) => {
  try {
    const properties = await fetchProperties();
    res.json(properties.map((p) => ({ id: p.Id, name: p.Name, numberUnits: p.NumberUnits })));
  } catch (err) {
    logError("GET /api/dashboard/properties failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load properties from Buildium." });
  }
});

dashboardRoutes.get("/api/dashboard/owners", async (_req, res) => {
  try {
    const owners = await fetchOwners();
    res.json(
      owners.map((o) => ({
        id: o.Id,
        name: o.IsCompany ? o.CompanyName : `${o.FirstName ?? ""} ${o.LastName ?? ""}`.trim(),
      }))
    );
  } catch (err) {
    logError("GET /api/dashboard/owners failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load owners from Buildium." });
  }
});

// ============================================================================
// Financials section (Dashboard tab): Rent By 3rd, Rent By 10th, Avg
// Rent/Lease, Avg SD Withheld, Avg SD Withheld %, Rent Collection — 12
// months chart, Delinquency Aging. All Buildium-only (no RentEngine/
// LeadSimple dependency).
//
// UNVERIFIED FIELD SHAPES, flagged per the same discipline as
// fetchGlEntries: CurrentRent.Amount, SecurityDeposit.Amount on
// BuildiumLease, and TransactionType on BuildiumLeaseTransaction are all
// best-guess schemas based on Buildium's OpenAPI spec, not yet confirmed
// against a live response (no Buildium credentials exist for this project
// yet). The MATH in src/kpi/rentCollection.ts and
// src/buildium/delinquency.ts is fully unit-tested; only the upstream
// field names are the open question, and this route will need a
// live-verified pass once Jason provisions the fresh Buildium key.
// ============================================================================

// Avg Rent/Lease, Avg SD Withheld, Avg SD Withheld % — STRUCTURAL (as-of-
// today across all active leases, not period-dependent).
dashboardRoutes.get("/api/dashboard/financials/rent-and-deposit", async (_req, res) => {
  try {
    const activeLeases = await fetchLeasesByStatus(["Active"]);
    res.json(summarizeRentAndDeposit(activeLeases));
  } catch (err) {
    logError("GET /api/dashboard/financials/rent-and-deposit failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load rent/deposit data from Buildium." });
  }
});

// Delinquency Aging breakdown (0-30/31-60/61-90/90+ day buckets) —
// STRUCTURAL, built on the same fetchOutstandingBalances() data as
// /api/dashboard/delinquency above, bucketed by days-late using each
// lease's PaymentDueDay.
dashboardRoutes.get("/api/dashboard/financials/delinquency-aging", async (_req, res) => {
  try {
    const [balances, activeLeases] = await Promise.all([fetchOutstandingBalances(), fetchLeasesByStatus(["Active"])]);
    const dueDayByLeaseId = new Map(activeLeases.map((l) => [String(l.Id), l.PaymentDueDay]));
    const asOf = new Date();

    const agingInputs = balances
      .filter((b) => b.balance > 0)
      .map((b) => ({
        leaseId: b.leaseId,
        balance: b.balance,
        daysLate: daysLateAsOf(dueDayByLeaseId.get(b.leaseId) ?? null, asOf),
      }));

    res.json(bucketDelinquencyByAge(agingInputs));
  } catch (err) {
    logError("GET /api/dashboard/financials/delinquency-aging failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load delinquency aging data from Buildium." });
  }
});

// Rent Collection — 12 months chart: % paid by the 3rd / by the 10th, per
// month, for the trailing 12 months. FLOW in spirit (spans a rolling
// window) but doesn't take the dashboard's period selector — it's always
// "the last 12 months," matching the vendor dashboard's own fixed chart
// window rather than the this/last month/quarter/year selector.
//
// N+1 WARNING, noted honestly: this fetches transactions per-lease
// (fetchLeaseTransactions is a single-lease call), so this endpoint makes
// one Buildium call per active lease. Fine for occasional dashboard loads
// at 230 units; if this becomes slow in practice once real data is
// flowing, the fix is a metric_cache-backed background sync (Neo's
// dashboard_metric_cache table already exists for exactly this) rather
// than computing it live on every request — flagged here rather than
// silently left as a surprise.
dashboardRoutes.get("/api/dashboard/financials/rent-collection", async (_req, res) => {
  try {
    const activeLeases = await fetchLeasesByStatus(["Active"]);
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setUTCMonth(twelveMonthsAgo.getUTCMonth() - 11);
    const monthsInWindow = last12Months(new Date());

    const duePerMonth = activeLeases.flatMap((lease) =>
      monthsInWindow.map((month) => ({ leaseId: String(lease.Id), month }))
    );

    const paymentsByLease = await Promise.all(
      activeLeases.map(async (lease) => {
        const transactions = await fetchLeaseTransactions(String(lease.Id));
        return earliestPaymentPerMonth(String(lease.Id), transactions);
      })
    );

    res.json(summarizeMonthlyCollectionRates(duePerMonth, paymentsByLease.flat()));
  } catch (err) {
    logError("GET /api/dashboard/financials/rent-collection failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load rent collection data from Buildium." });
  }
});

function last12Months(asOf: Date): string[] {
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

// ============================================================================
// FLOW tiles — respect the period selector. Currently exposes the resolved
// date range; monthly Gross/Net Income wiring is under /api/ceo-view/income
// (see ceoViewRoutes.ts) once GL endpoint shapes are confirmed against a
// real account (see src/buildium/client.ts research note on
// fetchGlEntries).
// ============================================================================

dashboardRoutes.get("/api/dashboard/period-info", (req, res) => {
  const parsed = periodSchema.safeParse(req.query.period);
  const period: PeriodKey = parsed.success ? parsed.data : "this_month";
  res.json({ period, range: resolvePeriod(period) });
});
