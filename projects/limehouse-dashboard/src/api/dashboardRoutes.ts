import { Router } from "express";
import { z } from "zod";
import {
  fetchOutstandingBalances,
  fetchProperties,
  fetchActiveProperties,
  fetchActiveResidentialUnits,
  fetchActiveManagedUnits,
  fetchAllUnits,
  fetchAllLeases,
  fetchActiveLeases,
  fetchOwners,
  fetchLeaseTransactions,
  fetchPendingApplicants,
  fetchAllApplicants,
  fetchUnitListing,
} from "../buildium/client.js";
import { fetchMarketingProcesses } from "../leadsimple/client.js";
import {
  summarizeDelinquency,
  delinquentLeaseRows,
  bucketDelinquencyByAge,
  leaseAgingInputsFromTransactions,
} from "../buildium/delinquency.js";
import {
  summarizeOccupancy,
  summarizeLeaseMix,
  upcomingRenewals,
  averageTenancyMonths,
  earliestTrackableMonth,
  monthsSinceEarliestTrackable,
  summarizeMonthlyOccupancy,
  summarizeYearlyOccupancy,
  findSameMonthLastYearOccupancy,
} from "../kpi/occupancy.js";
import { summarizePropertyHealthFromReporting } from "../rentengine/client.js";
import { getOrFetchLeasingPerformanceForAllUnits } from "../rentengine/leasingPerformanceCache.js";
import {
  buildPropertyManagementStarts,
  summarizeDoorsAdded,
  estimatePropertyLossDates,
  summarizeDoorsLostEstimate,
  summarizeNetDoorsYTD,
  summarizeTotalUnitsYoY,
  summarizeChurnByYear,
  netDoorsRows,
  doorsAddedRows,
} from "../kpi/churn.js";
import {
  rentLeaseRows,
  fixedTermLeaseRows,
  monthToMonthLeaseRows,
  evictionPendingLeaseRows,
  tenancyRows,
  moveInLeaseRows,
  unitStatusRows,
  vacantUnitRows,
  vacantUnitDaysRows,
  averageDaysVacant,
  type RenewalRateRow,
  type SecurityDepositWithheldRow,
} from "../kpi/leaseRows.js";
import { propertyAddressById, withPropertyAddress, unitNumberByLeaseId, withUnitNumber } from "../kpi/propertyLookup.js";
import { resolvePeriod, type PeriodKey } from "../kpi/period.js";
import { getExcludedPropertyIds, withPendingCloseOutCategory } from "../kpi/terminatedProperties.js";
import { groupOwners } from "../kpi/owners.js";
import { pendingApplicantRows } from "../kpi/applicants.js";
import { buildVacancyCycles, countApplicationsInCycles, groupVacancyRowsByUnit } from "../kpi/vacancyApplications.js";
import {
  summarizeRentAndDeposit,
  summarizeYearlyCollectionRates,
  findSameMonthLastYear,
  type MonthlyCollectionRate,
} from "../kpi/rentCollection.js";
import { getCachedMetric, isCacheFresh } from "../db/metricCache.js";
import { logError, logWarn } from "../lib/logger.js";
import { requireLogin } from "../auth/session.js";

// requireLogin applied per-route (not via dashboardRoutes.use()) — this
// router is mounted at the app root with no path prefix, and a blanket
// .use() here would catch every request that reaches this router's dispatch
// chain, including ones destined for routers mounted after it. See
// teamPerformanceRoutes.ts's comment for the real bug this caused before.
export const dashboardRoutes = Router();

const periodSchema = z
  .enum(["this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year"])
  .default("this_month");

// Same helper as rentEngineRoutes.ts's resolveDateRangeFromQuery (kept
// local rather than exported/shared across files, since it's a 4-line
// wrapper around resolvePeriod — not worth a cross-file import for this).
function resolveDateRangeFromQuery(periodRaw: unknown): { from: string; to: string } {
  const parsed = periodSchema.safeParse(periodRaw);
  const period: PeriodKey = parsed.success ? parsed.data : "this_month";
  const range = resolvePeriod(period);
  return { from: `${range.from}T00:00:00Z`, to: `${range.to}T23:59:59Z` };
}

// ============================================================================
// STRUCTURAL tiles — always as-of-today, period param is intentionally
// ignored if a caller sends one, per the brief's flow-vs-structural rule.
// ============================================================================

// CORRECTED 2026-07-03, second pass: the first fix (fetchAllUnits, one
// bulk call) solved the 404 crash but returned 401 units — Jason confirmed
// his real managed portfolio is ~230, matching CLAUDE.md. The extra ~171
// were inactive/former-client properties and 2 commercial units still
// present in Buildium's data but not actually managed today. Now uses
// fetchActiveResidentialUnits() (see src/buildium/client.ts for the full
// investigation — IsActive===true AND RentalType==="Residential" is the
// real distinguishing filter, confirmed against this account's actual
// data, landing on 233 units via two independent counting methods).
//
// CORRECTED 2026-07-04, third pass: switched from summarizeOccupancyFromUnits
// (trusting the unit record's raw IsUnitOccupied flag) to summarizeOccupancy
// (deriving "occupied" from having a currently-Active lease). CONFIRMED LIVE
// 2026-07-04 comparing against the vendor site side-by-side: IsUnitOccupied
// gave 211/233 = 90.6%, but the vendor showed 86.8%. Investigated 9 real
// units where IsUnitOccupied=true but no Active lease exists — every one is
// a transition gap where the outgoing tenant's lease already ended (Past)
// and the incoming tenant's lease hasn't started yet (Future, e.g. signed
// but move-in is 1-3 weeks out), so Buildium's IsUnitOccupied flag hasn't
// caught up even though no lease is currently Active. Deriving occupancy
// from Active-lease status instead gives 202/233 = 86.7%, matching the
// vendor almost exactly (the remaining ~0.1pt is the already-known,
// accepted 233-vs-234 total-unit-count variance). Only Active leases on a
// unit that's actually in our tracked residential set count, so this stays
// scoped to the same 233 units as before rather than picking up leases on
// properties fetchActiveResidentialUnits() intentionally excludes.
//
// CHANGED 2026-07-05: switched from fetchActiveResidentialUnits() (233
// units) to fetchActiveManagedUnits() (234 units) — Jason confirmed live he
// pays Buildium for and manages 234 doors total, including one Commercial
// property (6056 Providence Road, 1 unit) that the residential-only filter
// excluded. Total Units/Occupancy/Vacant should reflect everything he
// manages, not just the residential subset. See fetchActiveManagedUnits'
// doc comment in src/buildium/client.ts for why other metrics (Avg Rent/
// Lease, lease-mix, Revenue per Unit, Avg Days Vacant) were NOT changed.
dashboardRoutes.get("/api/dashboard/occupancy", requireLogin, async (_req, res) => {
  try {
    const [allUnits, activeLeases, excludedPropertyIds] = await Promise.all([
      fetchActiveManagedUnits(),
      fetchActiveLeases(),
      getExcludedPropertyIds(),
    ]);
    const units = allUnits.filter((u) => !excludedPropertyIds.has(String(u.PropertyId)));
    const trackedUnitIds = new Set(units.map((u) => u.Id));
    const activeLeasesOnTrackedUnits = activeLeases.filter((l) => trackedUnitIds.has(l.UnitId));
    const summary = summarizeOccupancy(units.length, activeLeasesOnTrackedUnits);
    // REVERTED 2026-07-09: this used to expose a separate vacantUnitsByFlag
    // (Buildium's own IsUnitOccupied flag) so the Vacant tile could match
    // the vendor's number, which at the time relied on that same flag.
    // Confirmed live against the vendor's own "Avg Days Vacant" drill-down
    // that the flag lags real lease-status transitions by up to ~2 weeks —
    // 12 units whose lease had already ended still showed occupied. Vacant
    // tile now uses summary.vacantUnits (lease-based, same signal as
    // Occupancy %) instead, per Jason directly — see leaseRows.ts's
    // unitStatusRows comment for the full story.
    const totalUnitsYoY = summarizeTotalUnitsYoY(units.length, new Date());
    res.json({ ...summary, totalUnitsYoY });
  } catch (err) {
    logError("GET /api/dashboard/occupancy failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load occupancy data from Buildium." });
  }
});

// Occupancy Rate — 12 Months chart — REBUILT 2026-07-09, per Jason
// directly: "year over year, for each month, as far back as can be
// tracked." See summarizeMonthlyOccupancy in occupancy.ts for the full
// reconstruction (real lease coverage per month, not a snapshot the
// vendor's version doesn't actually have going back that far). Returns
// every month from the earliest month we have any real lease evidence for
// (across currently-tracked units) through the current month, plus a
// by-year rollup and a same-month-last-year callout for the side panels
// — same shape as the Rent Collection year-over-year panels.
dashboardRoutes.get("/api/dashboard/occupancy-history", requireLogin, async (_req, res) => {
  try {
    const [allUnits, allLeases, excludedPropertyIds] = await Promise.all([
      fetchActiveManagedUnits(),
      fetchAllLeases(),
      getExcludedPropertyIds(),
    ]);
    const units = allUnits.filter((u) => !excludedPropertyIds.has(String(u.PropertyId)));
    const earliestMonth = earliestTrackableMonth(units, allLeases);
    if (earliestMonth === null) {
      res.json({ months: [], yearly: [], sameMonthLastYear: null });
      return;
    }
    const asOf = new Date();
    const monthList = monthsSinceEarliestTrackable(asOf, earliestMonth);
    const months = summarizeMonthlyOccupancy(units, allLeases, monthList, asOf);
    const yearly = summarizeYearlyOccupancy(months);
    const latestMonth = months[months.length - 1]?.month;
    const sameMonthLastYear = latestMonth ? findSameMonthLastYearOccupancy(months, latestMonth) : null;
    res.json({ months, yearly, sameMonthLastYear });
  } catch (err) {
    logError("GET /api/dashboard/occupancy-history failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load occupancy history from Buildium." });
  }
});

dashboardRoutes.get("/api/dashboard/lease-mix", requireLogin, async (_req, res) => {
  try {
    const activeLeases = await fetchActiveLeases();
    res.json(summarizeLeaseMix(activeLeases));
  } catch (err) {
    logError("GET /api/dashboard/lease-mix failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load lease mix data from Buildium." });
  }
});

// Avg Tenancy (Leasing Pipeline section) — STRUCTURAL, measured from each
// active lease's LeaseFromDate to today. See src/kpi/occupancy.ts for why
// this measures to LeaseFromDate rather than LeaseToDate (month-to-month
// leases have no end date and would otherwise be silently excluded).
dashboardRoutes.get("/api/dashboard/avg-tenancy", requireLogin, async (_req, res) => {
  try {
    const activeLeases = await fetchActiveLeases();
    const avgTenancyMonths = averageTenancyMonths(activeLeases, new Date());
    res.json({ avgTenancyMonths });
  } catch (err) {
    logError("GET /api/dashboard/avg-tenancy failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load average tenancy data from Buildium." });
  }
});

dashboardRoutes.get("/api/dashboard/delinquency", requireLogin, async (_req, res) => {
  try {
    const balances = await fetchOutstandingBalances();
    res.json(summarizeDelinquency(balances));
  } catch (err) {
    logError("GET /api/dashboard/delinquency failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load delinquency data from Buildium." });
  }
});

// Drill-down: property/unit/balance, sorted highest balance first.
dashboardRoutes.get("/api/dashboard/delinquency/leases", requireLogin, async (_req, res) => {
  try {
    const [balances, properties, activeLeases] = await Promise.all([
      fetchOutstandingBalances(),
      fetchProperties(),
      fetchActiveLeases(),
    ]);
    const rows = withUnitNumber(
      withPropertyAddress(delinquentLeaseRows(balances), propertyAddressById(properties)),
      unitNumberByLeaseId(activeLeases)
    );
    res.json(rows);
  } catch (err) {
    logError("GET /api/dashboard/delinquency/leases failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load delinquent lease list from Buildium." });
  }
});

const renewalsQuerySchema = z.object({
  withinDays: z.coerce.number().int().positive().max(365).default(60),
});

dashboardRoutes.get("/api/dashboard/renewals", requireLogin, async (req, res) => {
  const parsed = renewalsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid withinDays query param." });
    return;
  }
  try {
    const [activeLeases, properties] = await Promise.all([fetchActiveLeases(), fetchProperties()]);
    const rows = withPropertyAddress(upcomingRenewals(activeLeases, new Date(), parsed.data.withinDays), propertyAddressById(properties));
    res.json(rows);
  } catch (err) {
    logError("GET /api/dashboard/renewals failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load renewal data from Buildium." });
  }
});

// Renewal Rate (top-of-mind tile) — REBUILT 2026-07-05: "% of leases that
// renewed instead of moving out, over the trailing 12 months," replacing
// the old "% of active leases coming up for renewal in the next 60 days"
// definition. REBUILT AGAIN 2026-07-07: the "renewed" signal now comes
// from each lease's Rent recurring-charge schedule (see
// summarizeRenewalRate in src/kpi/occupancy.ts for the full derivation),
// which needs one Buildium call per non-Past lease — same rate-limit
// concern as Rent Collection/Security Deposit Withheld, so this reads a
// cache populated by POST /api/sync/renewal-rate instead of computing live.
dashboardRoutes.get("/api/dashboard/renewal-rate", requireLogin, async (_req, res) => {
  try {
    const cached = await getCachedMetric("renewal_rate", "portfolio");
    if (!cached || cached.value === null) {
      // 200 + synced:false, not a 503 — matches the same "not connected
      // yet" convention as the Total Calls/Outbound Texts tiles (a real
      // feed exists, it just hasn't been synced yet), so the frontend can
      // show the dashed "Not connected yet" tile instead of "Couldn't load".
      res.json({ synced: false });
      return;
    }
    const { summary } = cached.value as { summary: unknown; rows: unknown };
    res.json({ ...(summary as object), synced: true, stale: !isCacheFresh(cached), cachedAt: cached.fetchedAt, lastError: cached.lastError });
  } catch (err) {
    logError("GET /api/dashboard/renewal-rate failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load cached renewal rate data." });
  }
});

// Renewal Rate drill-down — the renewed/moved-out row list behind the
// percentage above. Reads the same cache as /api/dashboard/renewal-rate so
// the tile and its drill-down can never disagree.
dashboardRoutes.get("/api/dashboard/renewal-rate/leases", requireLogin, async (_req, res) => {
  try {
    const cached = await getCachedMetric("renewal_rate", "portfolio");
    if (!cached || cached.value === null) {
      res.json([]);
      return;
    }
    const { rows } = cached.value as { summary: unknown; rows: RenewalRateRow[] };
    const properties = await fetchProperties();
    res.json(withPropertyAddress(rows, propertyAddressById(properties)));
  } catch (err) {
    logError("GET /api/dashboard/renewal-rate/leases failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load cached renewal rate lease data." });
  }
});

dashboardRoutes.get("/api/dashboard/properties", requireLogin, async (_req, res) => {
  try {
    const properties = await fetchProperties();
    res.json(properties.map((p) => ({ id: p.Id, name: p.Name, numberUnits: p.NumberUnits })));
  } catch (err) {
    logError("GET /api/dashboard/properties failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load properties from Buildium." });
  }
});

// Property Health breakdown (Occupancy & Doors section) — CORRECTED
// 2026-07-04: the Buildium-derived formula below (classifyPropertyHealth,
// kept in src/kpi/propertyHealth.ts for reference/tests but no longer
// wired here) was WRONG. Jason found RentEngine's real docs
// (docs.rentengine.io/openapi), which confirmed Property Health is a REAL
// field RentEngine returns directly per unit
// (GET /reporting/leasing-performance/units/{unitId} -> property_health),
// with the exact same 7 category values used here as a coincidence-proof
// match to the Buildium guess, not evidence the guess was right. This is
// scoped to RentEngine's own ~61 tracked units (a real, different, smaller
// denominator than Buildium's ~201 active properties) — see
// src/rentengine/client.ts's summarizePropertyHealthFromReporting for the
// full note on that distinction. Cache-backed (same pattern as
// rent-collection/call-activity): computing this live would mean ~61
// RentEngine calls on every page load.
// CHANGED 2026-07-10, per Jason directly: adds a "Pending Close-Out"
// category on top of RentEngine's own 7 — the same terminated-but-not-
// yet-closed-out properties already excluded from Total Units/Vacant/
// Occupancy elsewhere (see src/kpi/terminatedProperties.ts). Confirmed
// with Jason this can't double-count against RentEngine's "Unknown"
// bucket — a terminated property is never listed again, so RentEngine has
// no record of it at all, not a mislabeled one.
dashboardRoutes.get("/api/dashboard/property-health", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  try {
    const [shared, excludedPropertyIds] = await Promise.all([
      getOrFetchLeasingPerformanceForAllUnits(from, to),
      getExcludedPropertyIds(),
    ]);
    if (!shared.connected) {
      res.json({ connected: false, totalUnits: null, countsByCategory: null });
      return;
    }
    if (shared.error || !shared.rows) {
      logError("GET /api/dashboard/property-health failed", { error: shared.error });
      res.status(502).json({ error: "Failed to load property health data from RentEngine.", detail: shared.error });
      return;
    }
    const summary = summarizePropertyHealthFromReporting(shared.rows);
    const countsByCategory = withPendingCloseOutCategory(summary.countsByCategory, excludedPropertyIds.size);
    res.json({
      connected: true,
      ...summary,
      countsByCategory,
      cached: shared.cached,
      cachedAt: shared.cachedAt,
      stale: shared.stale,
    });
  } catch (err) {
    logError("GET /api/dashboard/property-health failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load property health data from RentEngine." });
  }
});

// Doors Added (Occupancy & Doors section) — CORRECTED 2026-07-03: the
// original research (no CreatedDate/CreatedDateTime on /rentals or
// /rentals/units) was right that THOSE fields don't exist, but missed a
// real signal that does: /rentals/owners carries
// ManagementAgreementStartDate per owner, which IS a genuine
// "when did this door join the portfolio" date (see src/kpi/churn.ts).
// Verified live: 5/11/17 doors added in the trailing 30/60/90 days for
// this account, matching Jason's own expectation. A property with
// multiple owners whose start dates disagree by more than 30 days is
// flagged in flaggedDisagreements (logged, not silently resolved) — this
// account has 5 such properties as of 2026-07-03 (largest gap ~1,106
// days, which reads as a Buildium data-entry quirk, not a bug here).
//
// Doors Lost is an ESTIMATE, not a real figure — labeled that way in the
// response on purpose (doorsLostEstimated, not doorsLost). Buildium's
// ManagementAgreementEndDate is stale for this account (12 of 383 owner
// records have any end date, most recent 2023) and cannot be tracking
// Jason's real recent losses, so it is NOT used. Instead: for a property
// that is CURRENTLY IsActive:false, the most recent LeaseToDate across
// its leases approximates the loss date (Oracle-confirmed proxy — see
// src/kpi/churn.ts for the full derivation and its two documented
// limitations: undercounts properties with zero lease history, and can't
// apply the 30-day reactivation-confirmation rule retroactively since
// there's no history of past active/inactive flips to check it against).
// Verified live: 2 doors lost (estimated) in the last 31 days, 26 in the
// last 12 months — matches Oracle's numbers exactly.
dashboardRoutes.get("/api/dashboard/doors", requireLogin, async (_req, res) => {
  try {
    const [allProperties, allLeases, owners, managedUnits] = await Promise.all([
      fetchProperties(),
      fetchAllLeases(),
      fetchOwners(),
      fetchActiveManagedUnits(),
    ]);
    const activeProperties = allProperties.filter((p) => p.IsActive === true);
    const inactiveProperties = allProperties.filter((p) => p.IsActive === false);
    const activePropertyIds = new Set(activeProperties.map((p) => String(p.Id)));

    const { properties, flaggedDisagreements } = buildPropertyManagementStarts(owners, activePropertyIds, allLeases);
    const doorsAdded = summarizeDoorsAdded(properties, new Date());

    if (flaggedDisagreements.length > 0) {
      logWarn("Property Doors Added: co-owner management-start-date disagreements found", {
        count: flaggedDisagreements.length,
        flaggedDisagreements,
      });
    }

    const lossEstimates = estimatePropertyLossDates(inactiveProperties, allLeases);
    const doorsLostEstimated = summarizeDoorsLostEstimate(lossEstimates, inactiveProperties.length, new Date());
    const churnByYear = summarizeChurnByYear(lossEstimates, new Date());

    // Net Doors (Top of Mind) — EXACT, using Jason's own real door counts
    // as of Jan 1 each year, not the lease-history estimate above. See
    // summarizeNetDoorsYTD in churn.ts for why: the vendor's own "Net
    // Doors" is labeled trailing-12-months but is really only a ~50-day
    // daily-snapshot diff, so it isn't a meaningful target to chase either.
    const netDoorsYTD = summarizeNetDoorsYTD(managedUnits.length, new Date());

    res.json({
      doorsAdded,
      doorsAddedFlaggedDisagreements: flaggedDisagreements,
      doorsLostEstimated: {
        ...doorsLostEstimated,
        estimated: true,
        note:
          "Estimated from the most recent lease end date on each currently-inactive property, not a real deactivation date — likely undercounts properties that never had a Buildium lease on file (see propertiesUndercounted).",
      },
      churnByYear,
      netDoorsYTD,
    });
  } catch (err) {
    logError("GET /api/dashboard/doors failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load doors-added data from Buildium." });
  }
});

// CHANGED 2026-07-12, per Jason directly: raw Buildium owner RECORDS
// overcount real owners two ways (co-owners sharing one property each get
// their own record; the same real owner sometimes uses a different name/
// LLC on different properties) — see src/kpi/owners.ts for the full
// derivation. Groups the FULL owner list (fetchOwners, not
// fetchActiveOwners) so a link through an inactive record is never
// missed, then keeps only groups with at least one currently-active
// member, matching "how many owners am I actively managing for" rather
// than the vendor site's raw (and here, provably wrong) owner-record count.
dashboardRoutes.get("/api/dashboard/owners", requireLogin, async (_req, res) => {
  try {
    const owners = await fetchOwners();
    const activeGroups = groupOwners(owners).filter((g) => g.active);
    res.json(activeGroups);
  } catch (err) {
    logError("GET /api/dashboard/owners failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load owners from Buildium." });
  }
});

// Owners drill-down — same active-owner groups as the tile above, with
// property addresses resolved for the "Properties" column Jason asked
// for (each group's propertyIds map straight to real addresses via the
// same lookup every other drill-down on this dashboard already uses).
//
// FIXED 2026-07-12, per Jason directly: Buildium's owner records don't
// get cleaned up when a property goes inactive (sold, no longer
// managed) — an owner's PropertyIds array keeps referencing it forever.
// CONFIRMED LIVE against Red Lion Properties, the real example Jason
// flagged: 948 Ivy Avenue and 1610 Marciano Drive are both
// IsActive:false in Buildium but were still showing in the Properties
// column. The grouping itself (co-owner merging via shared PropertyIds)
// still uses the FULL history — a property they once co-owned together
// is still real evidence they're the same owner, even after that
// property is gone — but the properties actually LISTED here are
// filtered to currently-active ones only, matching what the owner
// genuinely still owns today.
dashboardRoutes.get("/api/dashboard/owners/list", requireLogin, async (_req, res) => {
  try {
    const [owners, properties] = await Promise.all([fetchOwners(), fetchProperties()]);
    const activePropertyIds = new Set(properties.filter((p) => p.IsActive === true).map((p) => String(p.Id)));
    const addressesByPropertyId = propertyAddressById(properties);
    const activeGroups = groupOwners(owners).filter((g) => g.active);
    res.json(
      activeGroups
        .map((g) => ({
          name: g.names.join(" / "),
          active: g.active,
          start: g.earliestStart,
          end: g.latestEnd,
          properties: g.propertyIds.filter((id) => activePropertyIds.has(id)).map((id) => addressesByPropertyId.get(id) ?? id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  } catch (err) {
    logError("GET /api/dashboard/owners/list failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load owners from Buildium." });
  }
});

// ============================================================================
// Financials section (Dashboard tab): Rent By 3rd, Rent By 10th, Avg
// Rent/Lease, Avg SD Withheld, Avg SD Withheld %, Rent Collection — 12
// months chart, Delinquency Aging. All Buildium-only (no RentEngine/
// LeadSimple dependency).
//
// Field shapes (AccountDetails.Rent/SecurityDeposit, Journal.Lines on
// transactions) are CONFIRMED LIVE against Jason's real Buildium account —
// this note used to flag them as unverified guesses before real credentials
// existed for this project; that's no longer the case. See rentCollection.ts
// for the verification history on each metric.
// ============================================================================

// Avg Rent/Lease — STRUCTURAL (as-of-today across all active leases).
//
// Avg SD Withheld / Avg SD Withheld % — REBUILT 2026-07-10, matching the
// vendor's own real methodology (see rentCollection.ts's comment above
// summarizeSecurityDepositWithheld for the full derivation). Both figures
// now come entirely from the cache — there's no "base" fallback value
// anymore, since the old fallback (avg deposit currently HELD on Active
// leases) was the wrong metric this whole rebuild replaced. This is a
// DIFFERENT population (recent Past/move-out leases within a specific
// window, not all Active ones) via POST /api/sync/security-deposit-withheld,
// cache-backed same as rent-collection — reads whatever the sync last
// computed rather than running the Past-lease/transaction fetch live on
// every page load.
dashboardRoutes.get("/api/dashboard/financials/rent-and-deposit", requireLogin, async (_req, res) => {
  try {
    const activeLeases = await fetchActiveLeases();
    const baseSummary = summarizeRentAndDeposit(activeLeases);

    const cached = await getCachedMetric("security_deposit_withheld", "portfolio");
    if (!cached || cached.value === null) {
      res.json({
        ...baseSummary,
        avgSecurityDepositWithheld: null,
        avgSecurityDepositWithheldPercent: null,
        securityDepositWithheldSynced: false,
        securityDepositWithheldMessage:
          "Security deposit withheld data has not been synced yet. Trigger POST /api/sync/security-deposit-withheld first.",
      });
      return;
    }

    const cachedValue = cached.value as {
      summary: { avgSecurityDepositWithheld: number | null; avgSecurityDepositWithheldPercent: number | null; reconciledLeaseCount: number };
    };
    res.json({
      ...baseSummary,
      avgSecurityDepositWithheld: cachedValue.summary.avgSecurityDepositWithheld,
      avgSecurityDepositWithheldPercent: cachedValue.summary.avgSecurityDepositWithheldPercent,
      securityDepositWithheldSynced: true,
      securityDepositWithheldStale: !isCacheFresh(cached),
      securityDepositWithheldCachedAt: cached.fetchedAt,
      reconciledLeaseCount: cachedValue.summary.reconciledLeaseCount,
    });
  } catch (err) {
    logError("GET /api/dashboard/financials/rent-and-deposit failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load rent/deposit data from Buildium." });
  }
});

// Delinquency Aging breakdown (0-30/31-60/61-90/90+ day buckets) —
// STRUCTURAL, built on the same fetchOutstandingBalances() data as
// /api/dashboard/delinquency above.
//
// FIXED 2026-07-06: this used to bucket every delinquent lease by
// daysLateAsOf(PaymentDueDay), which only ever looks at THIS month's or
// LAST month's due date — a balance unpaid for 2+ months still computed as
// <=30 days late, so every dollar landed in the "0-30" bucket regardless of
// real age (confirmed live against the vendor, which correctly splits the
// same total across all four buckets). Now walks each delinquent lease's
// real transaction history via leaseAgingInputsFromTransactions (FIFO
// ledger, oldest charge paid first, reconciled against Buildium's own
// trusted balance). Only fetches transactions for the small number of
// ACTUALLY delinquent leases (~17), not all ~230 active leases — the
// per-lease-in-Promise.all rate-limit problem documented below on the Rent
// Collection route was from doing this for every active lease on every
// page load; this scope is far smaller and doesn't need the same
// sync-job/cache treatment.
dashboardRoutes.get("/api/dashboard/financials/delinquency-aging", requireLogin, async (_req, res) => {
  try {
    const balances = await fetchOutstandingBalances();
    const delinquent = balances.filter((b) => b.balance > 0);
    const asOf = new Date();

    const perLeaseInputs = await Promise.all(
      delinquent.map(async (b) => {
        const transactions = await fetchLeaseTransactions(b.leaseId);
        return leaseAgingInputsFromTransactions(
          b.leaseId,
          b.balance,
          transactions.map((t) => ({ date: t.Date, totalAmount: t.TotalAmount })),
          asOf
        );
      })
    );

    res.json(bucketDelinquencyByAge(perLeaseInputs.flat()));
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
// CACHE-BACKED as of 2026-07-03 (confirmed live rate-limit issue, not
// hypothetical): this used to compute live on every page load by calling
// fetchLeaseTransactions once per active lease (~230 Buildium calls fired
// via Promise.all), which genuinely triggered real 429 rate-limit errors
// against Jason's live account. The expensive computation now runs only in
// POST /api/sync/rent-collection (syncRoutes.ts), spaced out sequentially
// rather than fired all at once, and writes its result to
// dashboard_metric_cache. This route just reads that cache — no Buildium
// calls on the page-load path at all. If the cache has never been
// populated yet (first run before any sync), this returns an honest 503
// telling the caller to trigger a sync, rather than falling back to the
// old expensive live path and reintroducing the exact rate-limit problem
// this fix exists to prevent.
// ADDED 2026-07-09, per Jason directly: two new pieces alongside the
// existing 12-month `months` array — a same-calendar-month-last-year
// callout and a by-year rollup list, for the new side panels next to the
// existing chart. Both are computed here from the FULL wide dataset the
// sync now stores (see monthsSinceYearsAgo in syncRoutes.ts), not just the
// last 12 months — `months` itself is deliberately left as the full wide
// array too (not sliced down to 12 server-side) so the frontend can build
// both the existing 12-month chart AND these wider panels from one
// response. The existing chart's own rendering slices to the most recent
// 12 itself (see renderRentCollectionChart in dashboard.js) so its visual
// output is unchanged despite the wider payload.
//
// STOPPED EXCLUDING THE CURRENT MONTH 2026-07-09, per Jason directly (see
// the matching note in syncRoutes.ts for the full reasoning): `months` now
// includes the still-in-progress current month, whose paidByThird/Tenth/
// MonthEndPercent fields are already correct at every point in the month —
// a live rolling figure before each cutoff passes, the true final figure
// once it does. `latestMonth` below is therefore now the CURRENT month
// (when it has any due leases), not last month — that's what makes
// sameMonthLastYear and the by-year rollup naturally reflect the most
// current data too. The frontend adds a "(so far)" qualifier on the Rent
// By 3rd/10th tiles specifically when the relevant cutoff hasn't passed
// yet (see renderFinancials in dashboard.js), and separately excludes the
// in-progress month when building the 12-month CHART, which is meant to
// keep showing only complete months, unchanged from before.
dashboardRoutes.get("/api/dashboard/financials/rent-collection", requireLogin, async (_req, res) => {
  try {
    const cached = await getCachedMetric("rent_collection_extended", "portfolio");
    if (!cached || cached.value === null) {
      res.status(503).json({
        error: "Rent collection data has not been synced yet. Trigger POST /api/sync/rent-collection first.",
      });
      return;
    }
    const months = cached.value as MonthlyCollectionRate[];
    const latestMonth = months.length > 0 ? months[months.length - 1].month : null;
    res.json({
      months,
      yearly: summarizeYearlyCollectionRates(months),
      sameMonthLastYear: latestMonth ? findSameMonthLastYear(months, latestMonth) : null,
      cachedAt: cached.fetchedAt,
      stale: !isCacheFresh(cached),
      lastError: cached.lastError,
    });
  } catch (err) {
    logError("GET /api/dashboard/financials/rent-collection failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load cached rent collection data." });
  }
});

// ============================================================================
// FLOW tiles — respect the period selector. Currently exposes the resolved
// date range; monthly Gross/Net Income wiring is under /api/ceo-view/income
// (see ceoViewRoutes.ts) once GL endpoint shapes are confirmed against a
// real account (see src/buildium/client.ts research note on
// fetchGlEntries).
// ============================================================================

dashboardRoutes.get("/api/dashboard/period-info", requireLogin, (req, res) => {
  const parsed = periodSchema.safeParse(req.query.period);
  const period: PeriodKey = parsed.success ? parsed.data : "this_month";
  res.json({ period, range: resolvePeriod(period) });
});

// ============================================================================
// Drill-downs added 2026-07-04, per Jason's original "exact copy — same
// layout and functionality" requirement (the vendor site has "tap any tile
// for the full record list" on ~30 tiles; most weren't built yet). Jason
// explicitly approved this batch EXCLUDING Rent By 3rd/10th and Avg SD
// Withheld — those two sit on a calculation already confirmed wrong (see
// src/kpi/rentCollection.ts's "KNOWN WRONG METRIC" notice) and are
// deliberately NOT getting drill-downs until that's fixed, so as not to
// present detailed per-lease numbers built on math everyone already knows
// is incorrect. Row shape matches the existing drill-downs (propertyId/
// leaseId as plain identifiers, not resolved property names/addresses —
// no existing drill-down resolves names either; that's a separate,
// larger change, not part of this batch).
// ============================================================================

// Renewal Rate drill-down — same underlying list as the Renewals tile
// itself (both are "leases renewing within 60 days"), just reached from a
// different tile. No new route needed — the frontend can call the
// existing /api/dashboard/renewals?withinDays=60 endpoint directly.

// Avg Rent/Lease drill-down.
dashboardRoutes.get("/api/dashboard/financials/rent-and-deposit/leases", requireLogin, async (_req, res) => {
  try {
    const [activeLeases, properties] = await Promise.all([fetchActiveLeases(), fetchProperties()]);
    const rows = withPropertyAddress(rentLeaseRows(activeLeases), propertyAddressById(properties));
    res.json(rows);
  } catch (err) {
    logError("GET /api/dashboard/financials/rent-and-deposit/leases failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load lease rent data from Buildium." });
  }
});

// Avg SD Withheld drill-down — ADDED 2026-07-10. Reads the SAME cached rows
// the sync built (see POST /api/sync/security-deposit-withheld), not a live
// recompute — building this list requires a transaction fetch per
// candidate lease, same rate-limit discipline as the rent-collection sync,
// so it only ever runs during the scheduled/manual sync, never on page load.
dashboardRoutes.get("/api/dashboard/financials/security-deposit-withheld/leases", requireLogin, async (_req, res) => {
  try {
    const cached = await getCachedMetric("security_deposit_withheld", "portfolio");
    if (!cached || cached.value === null) {
      res.status(503).json({
        error: "Security deposit withheld data has not been synced yet. Trigger POST /api/sync/security-deposit-withheld first.",
      });
      return;
    }
    const cachedValue = cached.value as { rows: SecurityDepositWithheldRow[] };
    const properties = await fetchProperties();
    res.json(withPropertyAddress(cachedValue.rows, propertyAddressById(properties)));
  } catch (err) {
    logError("GET /api/dashboard/financials/security-deposit-withheld/leases failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load security deposit withheld data." });
  }
});

// Total Units drill-down: every tracked unit with occupied/vacant status.
// CHANGED 2026-07-05: uses fetchActiveManagedUnits() (234 units, matches
// the Total Units tile above) instead of fetchActiveResidentialUnits() —
// see that route's comment for why.
dashboardRoutes.get("/api/dashboard/units", requireLogin, async (_req, res) => {
  try {
    const [allUnits, activeLeases, properties, excludedPropertyIds] = await Promise.all([
      fetchActiveManagedUnits(),
      fetchActiveLeases(),
      fetchProperties(),
      getExcludedPropertyIds(),
    ]);
    const units = allUnits.filter((u) => !excludedPropertyIds.has(String(u.PropertyId)));
    const trackedUnitIds = new Set(units.map((u) => u.Id));
    const activeLeasesOnTrackedUnits = activeLeases.filter((l) => trackedUnitIds.has(l.UnitId));
    res.json(withPropertyAddress(unitStatusRows(units, activeLeasesOnTrackedUnits), propertyAddressById(properties)));
  } catch (err) {
    logError("GET /api/dashboard/units failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load unit data from Buildium." });
  }
});

// Vacant — Not Rented drill-down.
// CHANGED 2026-07-05: uses fetchActiveManagedUnits() (234 units, matches
// the Vacant tile above) instead of fetchActiveResidentialUnits() — see
// /api/dashboard/occupancy's comment for why.
// CHANGED 2026-07-09: occupied now derived from Active-lease status
// instead of Buildium's own IsUnitOccupied flag — see leaseRows.ts's
// unitStatusRows comment for why (the flag lags real move-outs).
dashboardRoutes.get("/api/dashboard/units/vacant", requireLogin, async (_req, res) => {
  try {
    const [allUnits, activeLeases, properties, excludedPropertyIds] = await Promise.all([
      fetchActiveManagedUnits(),
      fetchActiveLeases(),
      fetchProperties(),
      getExcludedPropertyIds(),
    ]);
    const units = allUnits.filter((u) => !excludedPropertyIds.has(String(u.PropertyId)));
    const trackedUnitIds = new Set(units.map((u) => u.Id));
    const activeLeasesOnTrackedUnits = activeLeases.filter((l) => trackedUnitIds.has(l.UnitId));
    res.json(withPropertyAddress(vacantUnitRows(units, activeLeasesOnTrackedUnits), propertyAddressById(properties)));
  } catch (err) {
    logError("GET /api/dashboard/units/vacant failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load vacant unit data from Buildium." });
  }
});

// Avg Days Vacant — STRUCTURAL summary + drill-down. Previously hardcoded
// to "Not connected yet" even though it's fully computable from data
// already fetched elsewhere (fetchActiveResidentialUnits, fetchAllLeases)
// — no new endpoint needed, just never wired up. "Days vacant" for a unit
// with zero lease history on file is a genuine gap (no LeaseToDate to
// measure from) and is excluded from the average rather than guessed,
// same rule the Doors Lost estimate already follows.
dashboardRoutes.get("/api/dashboard/avg-days-vacant", requireLogin, async (_req, res) => {
  try {
    const [allUnits, allLeases, excludedPropertyIds] = await Promise.all([
      fetchActiveResidentialUnits(),
      fetchAllLeases(),
      getExcludedPropertyIds(),
    ]);
    const units = allUnits.filter((u) => !excludedPropertyIds.has(String(u.PropertyId)));
    const rows = vacantUnitDaysRows(units, allLeases, new Date());
    res.json({ avgDaysVacant: averageDaysVacant(rows), vacantUnitCount: rows.length });
  } catch (err) {
    logError("GET /api/dashboard/avg-days-vacant failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load avg days vacant data from Buildium." });
  }
});

dashboardRoutes.get("/api/dashboard/avg-days-vacant/units", requireLogin, async (_req, res) => {
  try {
    const [allUnits, allLeases, properties, excludedPropertyIds] = await Promise.all([
      fetchActiveResidentialUnits(),
      fetchAllLeases(),
      fetchProperties(),
      getExcludedPropertyIds(),
    ]);
    const units = allUnits.filter((u) => !excludedPropertyIds.has(String(u.PropertyId)));
    res.json(withPropertyAddress(vacantUnitDaysRows(units, allLeases, new Date()), propertyAddressById(properties)));
  } catch (err) {
    logError("GET /api/dashboard/avg-days-vacant/units failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load vacant unit day-count data from Buildium." });
  }
});

// Fixed-Term Leases / Month-to-Month drill-downs.
dashboardRoutes.get("/api/dashboard/lease-mix/fixed-term", requireLogin, async (_req, res) => {
  try {
    const [activeLeases, properties] = await Promise.all([fetchActiveLeases(), fetchProperties()]);
    res.json(withPropertyAddress(fixedTermLeaseRows(activeLeases), propertyAddressById(properties)));
  } catch (err) {
    logError("GET /api/dashboard/lease-mix/fixed-term failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load fixed-term lease data from Buildium." });
  }
});

dashboardRoutes.get("/api/dashboard/lease-mix/month-to-month", requireLogin, async (_req, res) => {
  try {
    const [activeLeases, properties] = await Promise.all([fetchActiveLeases(), fetchProperties()]);
    res.json(withPropertyAddress(monthToMonthLeaseRows(activeLeases), propertyAddressById(properties)));
  } catch (err) {
    logError("GET /api/dashboard/lease-mix/month-to-month failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load month-to-month lease data from Buildium." });
  }
});

// Move-Ins — FLOW summary + drill-down (respects the period selector).
// Previously hardcoded to "Not connected yet" even though it's fully
// computable from data already fetched elsewhere — same situation as Avg
// Days Vacant above, just never wired up.
dashboardRoutes.get("/api/dashboard/move-ins", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  try {
    const activeLeases = await fetchActiveLeases();
    res.json({ moveIns: moveInLeaseRows(activeLeases, from, to).length });
  } catch (err) {
    logError("GET /api/dashboard/move-ins failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load move-in data from Buildium." });
  }
});

// Apps Submitted — STRUCTURAL (as-of-today), not period-scoped. CONFIRMED
// LIVE 2026-07-06: previously hardcoded "Not connected yet" and mistagged
// as LeadSimple — real, live Buildium data. See fetchPendingApplicants'
// own comment for how "New + Undecided" was confirmed against the vendor's
// real number.
dashboardRoutes.get("/api/dashboard/apps-submitted", requireLogin, async (_req, res) => {
  try {
    const applicants = await fetchPendingApplicants();
    res.json({ appsSubmitted: applicants.length });
  } catch (err) {
    logError("GET /api/dashboard/apps-submitted failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load applicant data from Buildium." });
  }
});

// Apps Submitted drill-down — ADDED 2026-07-12. Same applicant population
// as the tile above; property address and unit number are resolved here
// the same way every other drill-down on this dashboard already does.
dashboardRoutes.get("/api/dashboard/apps-submitted/list", requireLogin, async (_req, res) => {
  try {
    const [applicants, properties, units] = await Promise.all([fetchPendingApplicants(), fetchProperties(), fetchAllUnits()]);
    const addressesByPropertyId = propertyAddressById(properties);
    const unitNumberByUnitId = new Map(units.filter((u) => u.UnitNumber).map((u) => [String(u.Id), u.UnitNumber as string]));
    const rows = pendingApplicantRows(applicants).map((r) => ({
      ...r,
      propertyAddress: r.propertyId ? addressesByPropertyId.get(r.propertyId) ?? r.propertyId : null,
      unitNumber: r.unitId ? unitNumberByUnitId.get(r.unitId) ?? null : null,
    }));
    res.json(rows);
  } catch (err) {
    logError("GET /api/dashboard/apps-submitted/list failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load applicant data from Buildium." });
  }
});

// Apps Per Vacancy drill-down — ADDED 2026-07-12, per Jason directly. A
// genuinely different, more detailed view than the Apps Per Move-In tile's
// own headline ratio (currently-pending applications ÷ move-ins this
// period, left unchanged) — see src/kpi/vacancyApplications.ts for the
// full derivation. Scoped to real active, non-terminated properties only,
// 5 years back. The per-unit /listing lookups are cheap here (only ~13
// units are ever actually listed at once on this account), unlike
// RentEngine's ~60-unit crawl elsewhere on this dashboard.
dashboardRoutes.get("/api/dashboard/apps-per-move-in/list", requireLogin, async (_req, res) => {
  try {
    const [allApplicants, allUnits, allLeases, properties, excludedPropertyIds, marketingProcessesResult] = await Promise.all([
      fetchAllApplicants(),
      fetchAllUnits(),
      fetchAllLeases(),
      fetchProperties(),
      getExcludedPropertyIds(),
      fetchMarketingProcesses(),
    ]);

    const activePropertyIds = new Set(properties.filter((p) => p.IsActive === true).map((p) => String(p.Id)));
    const eligibleUnits = allUnits.filter(
      (u) => activePropertyIds.has(String(u.PropertyId)) && !excludedPropertyIds.has(String(u.PropertyId))
    );

    const listedUnits = eligibleUnits.filter((u) => u.IsUnitListed);
    const listingEntries = await Promise.all(
      listedUnits.map(async (u) => {
        const listing = await fetchUnitListing(u.Id);
        return listing?.ListingDate ? ([String(u.Id), listing.ListingDate] as const) : null;
      })
    );
    const listingDateByUnitId = new Map(listingEntries.filter((e): e is [string, string] => e !== null));

    // Marketing Process records are matched to a Buildium property by
    // address (LeadSimple carries no Buildium property id) — same
    // technique already used for the terminated-properties feature.
    // Gracefully degrades to no extra cycles if LeadSimple isn't
    // connected or the call fails; this data is a real enhancement, not
    // a requirement for the rest of the report to work.
    const propertyIdByAddress = new Map<string, string>();
    for (const p of properties) {
      if (p.Address.AddressLine1) propertyIdByAddress.set(p.Address.AddressLine1, String(p.Id));
    }
    const marketingProcessDatesByPropertyId = new Map<string, string[]>();
    for (const proc of marketingProcessesResult.data ?? []) {
      const address = proc.properties[0]?.address;
      const propertyId = address ? propertyIdByAddress.get(address) : undefined;
      if (!propertyId) continue;
      const list = marketingProcessDatesByPropertyId.get(propertyId) ?? [];
      list.push(proc.created_at.slice(0, 10));
      marketingProcessDatesByPropertyId.set(propertyId, list);
    }
    for (const list of marketingProcessDatesByPropertyId.values()) list.sort();

    const cycles = buildVacancyCycles(eligibleUnits, allLeases, listingDateByUnitId, marketingProcessDatesByPropertyId, new Date(), 5);
    const rows = countApplicationsInCycles(cycles, allApplicants);

    const addressesByPropertyId = propertyAddressById(properties);
    const unitNumberByUnitId = new Map(allUnits.filter((u) => u.UnitNumber).map((u) => [String(u.Id), u.UnitNumber as string]));

    const grouped = groupVacancyRowsByUnit(rows);
    res.json(
      grouped.map((g) => ({
        propertyAddress: addressesByPropertyId.get(g.propertyId) ?? g.propertyId,
        unitNumber: unitNumberByUnitId.get(g.unitId) ?? null,
        vacancies: g.vacancies,
      }))
    );
  } catch (err) {
    logError("GET /api/dashboard/apps-per-move-in/list failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load vacancy/application data from Buildium." });
  }
});

dashboardRoutes.get("/api/dashboard/move-ins/leases", requireLogin, async (req, res) => {
  const { from, to } = resolveDateRangeFromQuery(req.query.period);
  try {
    const [activeLeases, properties] = await Promise.all([fetchActiveLeases(), fetchProperties()]);
    res.json(withPropertyAddress(moveInLeaseRows(activeLeases, from, to), propertyAddressById(properties)));
  } catch (err) {
    logError("GET /api/dashboard/move-ins/leases failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load move-in lease data from Buildium." });
  }
});

// Evictions Pending drill-down.
dashboardRoutes.get("/api/dashboard/evictions-pending", requireLogin, async (_req, res) => {
  try {
    const [activeLeases, properties] = await Promise.all([fetchActiveLeases(), fetchProperties()]);
    res.json(withPropertyAddress(evictionPendingLeaseRows(activeLeases), propertyAddressById(properties)));
  } catch (err) {
    logError("GET /api/dashboard/evictions-pending failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load eviction-pending data from Buildium." });
  }
});

// Avg Tenancy drill-down.
dashboardRoutes.get("/api/dashboard/avg-tenancy/leases", requireLogin, async (_req, res) => {
  try {
    const [activeLeases, properties] = await Promise.all([fetchActiveLeases(), fetchProperties()]);
    res.json(withPropertyAddress(tenancyRows(activeLeases, new Date()), propertyAddressById(properties)));
  } catch (err) {
    logError("GET /api/dashboard/avg-tenancy/leases failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load tenancy data from Buildium." });
  }
});

// Net Doors drill-down: combined Doors Added / Doors Lost (estimated) rows,
// each row tagged with its type so a single list can show both. Delegates
// to netDoorsRows (src/kpi/churn.ts) — see that function's comment for the
// two bugs fixed there 2026-07-05 (missing future-date guard, and added/lost
// using mismatched 90-day vs 12-month windows).
dashboardRoutes.get("/api/dashboard/net-doors/properties", requireLogin, async (_req, res) => {
  try {
    const [allProperties, allLeases, owners] = await Promise.all([fetchProperties(), fetchAllLeases(), fetchOwners()]);
    const activeProperties = allProperties.filter((p) => p.IsActive === true);
    const inactiveProperties = allProperties.filter((p) => p.IsActive === false);
    const activePropertyIds = new Set(activeProperties.map((p) => String(p.Id)));

    const { properties } = buildPropertyManagementStarts(owners, activePropertyIds, allLeases);
    const lossEstimates = estimatePropertyLossDates(inactiveProperties, allLeases);

    const rows = withPropertyAddress(netDoorsRows(properties, lossEstimates, new Date()), propertyAddressById(allProperties));
    res.json(rows);
  } catch (err) {
    logError("GET /api/dashboard/net-doors/properties failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load net doors data from Buildium." });
  }
});

// Doors Added drill-down: same year-to-date window as the Doors Added tile
// itself (doorsAddedYTD) — see doorsAddedRows in churn.ts for why this is
// scoped to YTD rather than the vendor's trailing-12-month daily-snapshot
// approach.
dashboardRoutes.get("/api/dashboard/doors-added/properties", requireLogin, async (_req, res) => {
  try {
    const [allProperties, allLeases, owners] = await Promise.all([fetchProperties(), fetchAllLeases(), fetchOwners()]);
    const activeProperties = allProperties.filter((p) => p.IsActive === true);
    const activePropertyIds = new Set(activeProperties.map((p) => String(p.Id)));

    const { properties } = buildPropertyManagementStarts(owners, activePropertyIds, allLeases);

    const rows = withPropertyAddress(doorsAddedRows(properties, new Date()), propertyAddressById(allProperties));
    res.json(rows);
  } catch (err) {
    logError("GET /api/dashboard/doors-added/properties failed", { error: String(err) });
    res.status(502).json({ error: "Failed to load doors-added data from Buildium." });
  }
});
