import { Router } from "express";
import { requireLogin, requireAdmin } from "../auth/session.js";
import { getScoredRoles } from "../db/kpiRepository.js";
import { periodToSnapshotLabel, resolvePeriod, quarterLabelToDateRange, periodEnumSchema, type PeriodKey } from "../kpi/period.js";
import { logError } from "../lib/logger.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import {
  fetchActiveManagedUnits,
  fetchActiveLeases,
  fetchOutstandingBalances,
  fetchVendors,
  fetchBankAccounts,
  fetchBankAccountReconciliations,
  fetchLeaseTransactions,
  fetchProperties,
} from "../buildium/client.js";
import { unitStatusRows } from "../kpi/leaseRows.js";
import { propertyAddressById, withPropertyAddress, unitNumberByLeaseId, withUnitNumber } from "../kpi/propertyLookup.js";
import { delinquentLeaseRows } from "../buildium/delinquency.js";
import { getExcludedPropertyIds } from "../kpi/terminatedProperties.js";
import {
  vendorComplianceExplainRows,
  nineNineComplianceExplainRows,
  reconciliationAccuracyExplainRows,
  rentProcessingAccuracyExplainRows,
  summarizeRentProcessingAccuracy,
  type ReconciliationAccuracyInput,
} from "../kpi/bookkeeperMetrics.js";
import { getOrFetchLeasingPerformanceForAllUnits } from "../rentengine/leasingPerformanceCache.js";
import {
  daysOnMarketExplainRows,
  showingCompletionRateExplainRows,
  fetchUnits,
  summarizeDaysOnMarket,
} from "../rentengine/client.js";
import {
  fetchApplicationProcesses,
  applicationProcessingTimeExplainRows,
  fetchApplicationsWithTasksForResponseTimeliness,
  applicantResponseTimelinessExplainRows,
  fetchLeaseRenewalProcesses,
  leaseRenewalRateExplainRows,
  fetchMoveInTasks,
  propertyReadinessExplainRows,
  fetchResidentResponseTasks,
  residentResponseTimeExplainRows,
  fetchLeaseRenewalTasks,
  renewalFollowUpTimelinessExplainRows,
  fetchTaskCompletionTasks,
  taskCompletionRateExplainRows,
  fetchWorkflowComplianceData,
  workflowComplianceExplainRows,
  fetchLeasingResponseTasks,
  leasingResponseTimeExplainRows,
} from "../leadsimple/client.js";

export const teamPerformanceRoutes = Router();

// The shared-password check-password/status routes that used to live here
// are gone — real per-person Microsoft sign-in replaced the shared password
// entirely (see migrations/0007_drop_team_performance_password.ts).
// /roles is now gated the same way CEO View is: signed in AND Admin.

// CONSOLIDATED 2026-07-30, per Judge's code-quality review — see
// periodEnumSchema's own comment in src/kpi/period.ts.
const periodQuerySchema = periodEnumSchema.default("this_quarter");

const QUARTER_LABEL_PATTERN = /^\d{4}-Q[1-4]$/;

// ADDED 2026-07-19, per Jason directly, against a real vendor screenshot:
// the vendor's Team Performance tab has its OWN dedicated Q1-Q4 quarter
// tabs, independent of the shared this_month/this_quarter/etc. dropdown
// used everywhere else on the dashboard — a `quarter` param (e.g.
// "2026-Q3") lets the frontend jump straight to any quarter of the current
// year. Falls back to the existing `period`-based resolution (which
// correctly lands on the REAL current quarter via periodToSnapshotLabel)
// when no explicit quarter is given, so the page still defaults sensibly
// on first load.
teamPerformanceRoutes.get("/api/team-performance/roles", requireLogin, requireAdmin, async (req, res) => {
  try {
    const quarterParam = req.query.quarter;
    let snapshotLabel: string;
    if (typeof quarterParam === "string" && QUARTER_LABEL_PATTERN.test(quarterParam)) {
      snapshotLabel = quarterParam;
    } else {
      const parsed = periodQuerySchema.safeParse(req.query.period);
      const period: PeriodKey = parsed.success ? parsed.data : "this_quarter";
      snapshotLabel = periodToSnapshotLabel(period);
    }

    const { from, to } = quarterLabelToDateRange(snapshotLabel);

    // Quarterly Trend — real history across every quarter of the currently
    // viewed year (matches the Q1-Q4 tab set), per role. Only actually
    // populates once the (separately scheduled) KPI snapshot sync has run
    // for a given quarter — a quarter with no snapshot data at all for a
    // role just carries hasData:false so the frontend can honestly skip it
    // rather than drawing a fake empty bar.
    const year = Number(snapshotLabel.slice(0, 4));
    const quarterLabelsThisYear = [1, 2, 3, 4].map((q) => `${year}-Q${q}`);
    const otherQuarters = quarterLabelsThisYear.filter((label) => label !== snapshotLabel);

    const [roles, ...otherResults] = await Promise.all([
      getScoredRoles(snapshotLabel, "team_performance"),
      ...otherQuarters.map((label) => getScoredRoles(label, "team_performance")),
    ]);

    const resultsByQuarter = new Map(otherQuarters.map((label, i) => [label, otherResults[i]]));
    resultsByQuarter.set(snapshotLabel, roles);

    const rolesWithTrend = roles.map((role) => ({
      ...role,
      trend: quarterLabelsThisYear.map((label) => {
        const match = resultsByQuarter.get(label)!.find((r) => r.role === role.role);
        return {
          period: label,
          hasData: (match?.scoredKpiCount ?? 0) > 0,
          percentOfMax: match?.percentOfMax ?? 0,
          totalPayoutUsd: match?.totalPayoutUsd ?? 0,
        };
      }),
    }));

    res.json({ period: snapshotLabel, periodStart: from, periodEnd: to, roles: rolesWithTrend });
  } catch (err) {
    logError("GET /api/team-performance/roles failed", { error: String(err) });
    res.status(500).json({ error: "Failed to load Team Performance data." });
  }
});

// KPI "explain" drill-down — click a KPI, see the plain-English formula
// plus the real records behind the number, matching the vendor site's own
// "tap any KPI to see the data behind it" pattern. Only the KPIs with a
// real, live-verified formula (2026-07-05) are wired here — anything else
// 404s with a clear message rather than fabricating an explanation.
const KPI_EXPLAIN_FORMULAS: Record<string, string> = {
  "Portfolio Occupancy Rate": "Occupied units ÷ total managed units, including the 1 commercial property, excluding properties Jason's team has terminated management on but Buildium hasn't closed out yet. A unit counts as occupied only if it has a real Active lease with a current tenant on file.",
  "Delinquency Rate": "Sum of TotalBalance across active leases with a positive balance ÷ sum of monthly rent across all active leases. Source: Buildium /leases/outstandingbalances and the rent field on active leases.",
  "Reconciliation Accuracy": "Across active bank accounts, how many fully-completed months in this period have a finished bank reconciliation (statement ending date in that month, marked finished). A partial current month never counts. Accounts with $0 balance and no reconciliations are excluded (nothing to reconcile).",
  "Rent Processing Accuracy": "1 − (operational payment reversals ÷ total payments), across every active lease this period. NSF/bounced/chargeback reversals are tenant-caused, not a processing error, so they're excluded from the percentage (but listed below for reference).",
  "Vendor Compliance": "Of your active maintenance/trade vendors (Contractors category), the share with both a tax ID on file and current (non-expired) liability insurance.",
  "1099 Compliance": "Of your active maintenance/trade vendors flagged for 1099 reporting, the share that have a tax ID on file.",
  "Days on Market": "True days_on_market from RentEngine's per-unit leasing-performance report (resets when a unit is re-listed).",
  "Application Processing Time": "Average hours from when an application came in to when it closed out, across every Applications Process both created AND closed this period.",
  "Applicant Response Timeliness": "Of every Application that came in over the trailing 90 days, the share where the first task on it got completed within 24 hours. Applications with no completed task yet count against the rate. Note: this counts only applications that arrived in the last 90 days — it deliberately excludes old, already-closed applications whose only recent activity is an unrelated administrative task (e.g. a bookkeeping fee charge), which would otherwise skew the score with stale backlog noise.",
  "Showing Completion Rate": "Showings completed ÷ showings scheduled, across AVAILABLE listings only (RentEngine's own unit status isn't \"Leased\") for the selected period. RentEngine doesn't break showings into accompanied vs. self-guided, so self-showings can't be excluded from either side.",
  "Property Readiness": "Of the tasks in LeadSimple's Move In Process due this period, the share completed by their due date. A task not yet completed counts against the rate. Source: LeadSimple tasks on the 06 Move In Process workflow.",
  "Resident Response Time": "Average business hours (Mon-Fri, 9am-5pm Eastern, excluding US federal holidays) for Addison to complete her own email/todo/meet tasks in LeadSimple, from task creation to completion.",
  // ADDED 2026-07-27, per Jason directly. On-time rule is a disclosed
  // approximation, not vendor-confirmed exactly -- see the note builder in
  // team-performance.js and the comment above summarizeRenewalFollowUpTimeliness
  // in src/leadsimple/client.ts for the full story.
  "Renewal Follow-Up Timeliness": "Of the real todo tasks on the 07 Lease Renewal Process completed this period, the share completed by (or before) their due date's calendar day. Source: LeadSimple tasks, kind = todo.",
  // ADDED 2026-07-27, per Jason directly. On-time rule is vendor-confirmed
  // exactly (their own note text); population is a disclosed
  // approximation -- see the note builder in team-performance.js and the
  // comment above summarizeTaskCompletionRate in src/leadsimple/client.ts.
  "Task Completion Rate": "Of the real todo and process-kind tasks assigned to Belinda, completed this period, the share completed on or before the due date's calendar day (Eastern Time). Source: LeadSimple tasks, kind = todo or process.",
  // ADDED 2026-07-27, per Jason directly, against a real vendor drilldown
  // screenshot. Compliance rule (skipped=0 and late=0) is confirmed exact
  // against all 9 visible rows; process-type scope (Applications/Move
  // In/Marketing only) is a disclosed approximation -- see the note
  // builder in team-performance.js and the comment above
  // summarizeWorkflowCompliance in src/leadsimple/client.ts.
  "Workflow Compliance": "Of the 05 Applications/06 Move In/04 Marketing Processes created this period with at least one task assigned to Belinda, the share where none of her tasks were skipped and none were completed late (an incomplete task doesn't count against her on its own). Source: LeadSimple processes and tasks, assignee.email = assistant@limehousepm.com.",
  // ADDED 2026-07-27, per Jason directly, against a real vendor drilldown
  // screenshot (the vendor's own modal is titled "Resident Response Time
  // -- Admin Assistant", reusing that name/style from the unrelated
  // Portfolio Assistant KPI -- matched in the frontend title override, not
  // here). Formula confirmed exact from the screenshot's own note text.
  "Leasing Response Time": "Average business hours (Mon-Fri, 9am-5pm Eastern, excluding US federal holidays) for Belinda to complete her own email/todo/meet tasks in LeadSimple, measured from each task's due date to its completion (not from when it was assigned). A task finished before its own due date scores 0 hours.",
  // CORRECTED 2026-07-19, per Jason directly, against a real vendor
  // screenshot: enumerates the same 4 non-renewal outcomes the vendor's
  // own note text lists by name — the underlying scoring logic already
  // handled all 4 correctly (anything outside Upcoming/Send Lease counts
  // as decided), this only makes the wording as explicit as the vendor's.
  "Lease Renewal Rate": "Lease Renewal Processes in trailing 12 months. Rate = renewed ÷ decided, where \"decided\" excludes still-in-progress processes (e.g. Send Lease, Upcoming). \"Renewed\" = a completed Lease Renewed outcome; non-renewal outcomes (owner/tenant non-renewal, owner terminating management, owner relisting, owner selling) count as not renewed.",
};

// ADDED 2026-07-19, per Jason directly: this used to only accept the
// shared this_month/this_quarter/etc. period, so a KPI clicked while
// viewing a past quarter's Q1-Q4 tab (added above) still explained
// whatever the UNRELATED shared header dropdown happened to be set to,
// not the quarter actually on screen — a real drill-down/tile mismatch,
// exactly what Jason asked this deep-dive to catch. Accepts an explicit
// `quarter` param now, same as /roles above, taking precedence over
// `period`. Note this still can't show TRUE historical records for a
// quarter that's fully in the past — every explain-rows function below
// queries Buildium/RentEngine/LeadSimple live, as of right now, there's
// no stored historical record set to read instead — but the date WINDOW
// passed into each calculation is now at least the real quarter's bounds
// instead of an unrelated one.
teamPerformanceRoutes.get("/api/team-performance/kpi-explain/:kpiName", requireLogin, requireAdmin, async (req, res) => {
  const kpiName = req.params.kpiName;
  const formula = KPI_EXPLAIN_FORMULAS[kpiName];
  if (!formula) {
    res.status(404).json({ error: `No live formula/drill-down wired up yet for "${kpiName}".` });
    return;
  }
  const quarterParam = req.query.quarter;
  let from: string;
  let to: string;
  if (typeof quarterParam === "string" && QUARTER_LABEL_PATTERN.test(quarterParam)) {
    const fullQuarter = quarterLabelToDateRange(quarterParam);
    const today = new Date().toISOString().slice(0, 10);
    from = fullQuarter.from;
    to = fullQuarter.to > today ? today : fullQuarter.to;
  } else {
    const parsed = periodQuerySchema.safeParse(req.query.period);
    const period: PeriodKey = parsed.success ? parsed.data : "this_quarter";
    ({ from, to } = resolvePeriod(period));
  }

  try {
    switch (kpiName) {
      // CORRECTED 2026-07-19, per Jason directly, against a real vendor
      // screenshot: this used to return a bare unitId with no property
      // address or unit number at all (occupancyExplainRows) — the vendor's
      // real drill-down shows PROPERTY/UNIT/OCCUPIED columns. Switched to
      // unitStatusRows + withPropertyAddress, the SAME real-address join
      // already used for every other Dashboard drill-down (dashboardRoutes.ts),
      // just never wired up here when this KPI explain route was first built.
      case "Portfolio Occupancy Rate": {
        const [allUnits, activeLeases, excludedPropertyIds, properties] = await Promise.all([
          fetchActiveManagedUnits(),
          fetchActiveLeases(),
          getExcludedPropertyIds(),
          fetchProperties(),
        ]);
        const units = allUnits.filter((u) => !excludedPropertyIds.has(String(u.PropertyId)));
        const rows = withPropertyAddress(unitStatusRows(units, activeLeases), propertyAddressById(properties));
        res.json({ kpiName, formula, rows });
        return;
      }
      case "Delinquency Rate": {
        const [balances, properties, activeLeases] = await Promise.all([
          fetchOutstandingBalances(),
          fetchProperties(),
          fetchActiveLeases(),
        ]);
        const rows = withUnitNumber(
          withPropertyAddress(delinquentLeaseRows(balances), propertyAddressById(properties)),
          unitNumberByLeaseId(activeLeases)
        );
        res.json({ kpiName, formula, rows });
        return;
      }
      case "Vendor Compliance": {
        const vendors = await fetchVendors();
        const rows = vendorComplianceExplainRows(vendors);
        res.json({ kpiName, formula, rows });
        return;
      }
      case "1099 Compliance": {
        const vendors = await fetchVendors();
        const rows = nineNineComplianceExplainRows(vendors);
        res.json({ kpiName, formula, rows });
        return;
      }
      case "Reconciliation Accuracy": {
        const bankAccounts = await fetchBankAccounts();
        const reconInputs: ReconciliationAccuracyInput[] = [];
        for (const account of bankAccounts) {
          const { reconcilable, reconciliations } = await fetchBankAccountReconciliations(account.Id);
          reconInputs.push({ account, reconcilable, reconciliations });
        }
        const rows = reconciliationAccuracyExplainRows(reconInputs, from, to);
        res.json({ kpiName, formula, rows, from, to });
        return;
      }
      case "Rent Processing Accuracy": {
        const [activeLeases, properties] = await Promise.all([fetchActiveLeases(), fetchProperties()]);
        // Concurrency-limited, not fully sequential or fully parallel —
        // fixed 2026-07-26, per Jason directly ("sure does take a long
        // time to load"). Awaiting leases one at a time (~215 leases) was
        // slow; firing all of them at once instead got Buildium to
        // rate-limit us hard enough that even its own retry-with-backoff
        // couldn't recover (CONFIRMED LIVE). A fixed cap of 10 in flight
        // gets most of the speedup without tripping the limit.
        const transactionsByLease = await mapWithConcurrency(activeLeases, 10, (lease) =>
          fetchLeaseTransactions(String(lease.Id))
        );
        const summary = summarizeRentProcessingAccuracy(transactionsByLease, from, to);
        const propertyIdByLeaseId = new Map(activeLeases.map((l) => [String(l.Id), String(l.PropertyId)]));
        const rawRows = rentProcessingAccuracyExplainRows(transactionsByLease, from, to).map((r) => ({
          ...r,
          propertyId: propertyIdByLeaseId.get(r.leaseId) ?? "",
        }));
        const rows = withUnitNumber(
          withPropertyAddress(rawRows, propertyAddressById(properties)),
          unitNumberByLeaseId(activeLeases)
        );
        res.json({
          kpiName,
          formula,
          rows,
          from,
          to,
          paymentCount: summary.paymentCount,
          operationalReversalCount: summary.operationalReversalCount,
          nsfReversalCount: summary.nsfReversalCount,
          activeLeaseCount: activeLeases.length,
        });
        return;
      }
      case "Days on Market": {
        const [leasingPerf, units] = await Promise.all([
          getOrFetchLeasingPerformanceForAllUnits(from, to),
          fetchUnits(),
        ]);
        if (!leasingPerf.connected || !leasingPerf.rows) {
          res.status(502).json({ error: "RentEngine isn't connected — can't load the data behind Days on Market." });
          return;
        }
        const rows = daysOnMarketExplainRows(leasingPerf.rows, units.connected && units.data ? units.data : []);
        const summary = summarizeDaysOnMarket(leasingPerf.rows);
        res.json({
          kpiName,
          formula,
          rows,
          avgDaysOnMarket: summary.avgDaysOnMarket,
          medianDaysOnMarket: summary.medianDaysOnMarket,
        });
        return;
      }
      case "Application Processing Time": {
        const applications = await fetchApplicationProcesses();
        if (!applications.connected || !applications.data) {
          res.status(502).json({ error: "LeadSimple isn't connected — can't load the data behind Application Processing Time." });
          return;
        }
        const rows = applicationProcessingTimeExplainRows(applications.data, from, to);
        res.json({ kpiName, formula, rows, from, to });
        return;
      }
      case "Applicant Response Timeliness": {
        // CHANGED 2026-07-26, per Jason directly: the "(90d)" trailing
        // window this used to assume was based on stale vendor wording — a
        // real screenshot showed an explicit "(2026-07-01 – 2026-07-26)"
        // range instead, matching this route's own quarter-to-date `from`/
        // `to` (already resolved above), not a fixed 90-day lookback.
        const responseData = await fetchApplicationsWithTasksForResponseTimeliness(from);
        if (!responseData.connected || !responseData.data) {
          res.status(502).json({ error: "LeadSimple isn't connected — can't load the data behind Applicant Response Timeliness." });
          return;
        }
        const rows = applicantResponseTimelinessExplainRows(
          responseData.data.processes,
          responseData.data.tasksByProcessId,
          from,
          to
        );
        res.json({ kpiName, formula, rows, from, to });
        return;
      }
      case "Showing Completion Rate": {
        const leasingPerf = await getOrFetchLeasingPerformanceForAllUnits(from, to);
        if (!leasingPerf.connected || !leasingPerf.rows) {
          res.status(502).json({ error: "RentEngine isn't connected — can't load the data behind Showing Completion Rate." });
          return;
        }
        const units = await fetchUnits();
        if (!units.connected || !units.data) {
          res.status(502).json({ error: "RentEngine isn't connected — can't load the data behind Showing Completion Rate." });
          return;
        }
        const rows = showingCompletionRateExplainRows(leasingPerf.rows, units.data);
        res.json({ kpiName, formula, rows });
        return;
      }
      case "Property Readiness": {
        const moveInTasks = await fetchMoveInTasks(from);
        if (!moveInTasks.connected || !moveInTasks.data) {
          res.status(502).json({ error: "LeadSimple isn't connected — can't load the data behind Property Readiness." });
          return;
        }
        const rows = propertyReadinessExplainRows(moveInTasks.data, from, to);
        res.json({ kpiName, formula, rows, from, to });
        return;
      }
      case "Resident Response Time": {
        const residentTasks = await fetchResidentResponseTasks(from);
        if (!residentTasks.connected || !residentTasks.data) {
          res.status(502).json({ error: "LeadSimple isn't connected — can't load the data behind Resident Response Time." });
          return;
        }
        const rows = residentResponseTimeExplainRows(residentTasks.data, from, to);
        res.json({ kpiName, formula, rows, from, to });
        return;
      }
      case "Renewal Follow-Up Timeliness": {
        const renewalTasks = await fetchLeaseRenewalTasks(from);
        if (!renewalTasks.connected || !renewalTasks.data) {
          res.status(502).json({ error: "LeadSimple isn't connected — can't load the data behind Renewal Follow-Up Timeliness." });
          return;
        }
        const rows = renewalFollowUpTimelinessExplainRows(renewalTasks.data, from, to);
        res.json({ kpiName, formula, rows, from, to });
        return;
      }
      case "Task Completion Rate": {
        const belindaTasks = await fetchTaskCompletionTasks(from);
        if (!belindaTasks.connected || !belindaTasks.data) {
          res.status(502).json({ error: "LeadSimple isn't connected — can't load the data behind Task Completion Rate." });
          return;
        }
        const rows = taskCompletionRateExplainRows(belindaTasks.data, from, to);
        res.json({ kpiName, formula, rows, from, to });
        return;
      }
      case "Workflow Compliance": {
        const workflowData = await fetchWorkflowComplianceData(from);
        if (!workflowData.connected || !workflowData.data) {
          res.status(502).json({ error: "LeadSimple isn't connected — can't load the data behind Workflow Compliance." });
          return;
        }
        const rows = workflowComplianceExplainRows(workflowData.data, from, to);
        res.json({ kpiName, formula, rows, from, to });
        return;
      }
      case "Leasing Response Time": {
        const leasingResponseTasks = await fetchLeasingResponseTasks(from);
        if (!leasingResponseTasks.connected || !leasingResponseTasks.data) {
          res.status(502).json({ error: "LeadSimple isn't connected — can't load the data behind Leasing Response Time." });
          return;
        }
        const rows = leasingResponseTimeExplainRows(leasingResponseTasks.data, from, to);
        res.json({ kpiName, formula, rows, from, to });
        return;
      }
      case "Lease Renewal Rate": {
        const now = new Date();
        const windowStart = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const windowEnd = now.toISOString().slice(0, 10);
        const renewalProcesses = await fetchLeaseRenewalProcesses();
        if (!renewalProcesses.connected || !renewalProcesses.data) {
          res.status(502).json({ error: "LeadSimple isn't connected — can't load the data behind Lease Renewal Rate." });
          return;
        }
        const rows = leaseRenewalRateExplainRows(renewalProcesses.data, windowStart, windowEnd);
        res.json({ kpiName, formula, rows });
        return;
      }
      default:
        res.status(404).json({ error: `No live formula/drill-down wired up yet for "${kpiName}".` });
    }
  } catch (err) {
    logError("GET /api/team-performance/kpi-explain failed", { kpiName, error: String(err) });
    res.status(502).json({ error: `Failed to load the data behind "${kpiName}".` });
  }
});
