// Tab 1: Dashboard. Renders every section from the visual spec. Tiles
// backed by a real API route show real numbers. As of 2026-07-04, Financials,
// Property Health, Avg Tenancy, Leasing Funnel, New Prospects by Source,
// Units on Market, New Prospects/marketing-activity, Doors Added/Lost, and
// Avg/Median Days on Market are all wired to real Buildium/RentEngine
// routes and confirmed live (Property Health and Days on Market were
// corrected on 2026-07-04 — an earlier pass wrongly concluded they were
// unavailable; Jason pushed back on both and was right).
//
// Two DIFFERENT kinds of "not showing a number" exist here, worded
// differently on purpose so Jason can tell them apart at a glance:
//   - "Not connected yet" (dashed border) — a real feed could exist here,
//     just isn't wired up / synced yet (e.g. the Doors 12-month monthly
//     chart, or Total Calls/Outbound Texts before their first sync).
//   - "Not tracked in Buildium/RentEngine" (solid border, notAvailableBox)
//     — confirmed with Q that no field or timestamp exists to compute this
//     at all, for any period, even going forward without new tracking that
//     doesn't exist yet. Completion Rate no longer falls in this bucket —
//     CORRECTED 2026-07-05, it's real and live (see the Marketing &
//     Showings section comment below).
// Owners-gained-this-period still has no backend feed at all yet and keeps
// the "Not connected yet" wording.

document.addEventListener("DOMContentLoaded", () => {
  renderHeader("dashboard");
  loadDashboard();
  window.addEventListener("lh:period-changed", loadDashboard);
  window.addEventListener("lh:sync-complete", loadDashboard);
});

// Every API call this tab needs, fetched independently via
// Promise.allSettled rather than one shared Promise.all. A single failed
// call (e.g. Buildium unreachable) must only blank the tiles that actually
// depend on it — sections that don't need that call still render normally.
// This matters in practice: right now RentEngine/LeadSimple-only tiles show
// as "Not connected yet" regardless, but once Buildium-backed endpoints are
// live, a transient failure on one of them (say /owners) must not also take
// down Total Delinquent or Occupancy, which come from different calls.
async function loadDashboard() {
  const content = document.getElementById("page-content");
  const contextLine = document.getElementById("context-line");
  const period = getStoredPeriod();

  content.innerHTML = `<p class="loading-text">Loading dashboard…</p>`;

  const [
    periodInfoResult,
    occupancyResult,
    occupancyHistoryResult,
    leaseMixResult,
    delinquencyResult,
    renewalsResult,
    renewalsMonthlyResult,
    renewalRateResult,
    ownersResult,
    rentAndDepositResult,
    delinquencyAgingResult,
    rentCollectionResult,
    propertyHealthResult,
    doorsResult,
    avgTenancyResult,
    leasingFunnelResult,
    prospectsBySourceResult,
    unitsOnMarketResult,
    marketingActivityResult,
    completionRateResult,
    daysOnMarketResult,
    moveInsResult,
    avgDaysVacantResult,
    appsSubmittedResult,
  ] = await Promise.allSettled([
    apiGet(`/api/dashboard/period-info?period=${period}`),
    apiGet("/api/dashboard/occupancy"),
    apiGet("/api/dashboard/occupancy-history"),
    apiGet("/api/dashboard/lease-mix"),
    apiGet("/api/dashboard/delinquency"),
    apiGet("/api/dashboard/renewals"),
    apiGet("/api/dashboard/renewals/monthly"),
    apiGet("/api/dashboard/renewal-rate"),
    apiGet("/api/dashboard/owners"),
    apiGet("/api/dashboard/financials/rent-and-deposit"),
    apiGet("/api/dashboard/financials/delinquency-aging"),
    apiGet("/api/dashboard/financials/rent-collection"),
    apiGet("/api/dashboard/property-health"),
    apiGet("/api/dashboard/doors"),
    apiGet("/api/dashboard/avg-tenancy"),
    apiGet(`/api/rentengine/leasing-funnel?period=${period}`),
    apiGet(`/api/rentengine/prospects-by-source?period=${period}`),
    apiGet("/api/rentengine/units-on-market"),
    apiGet(`/api/rentengine/marketing-activity?period=${period}`),
    apiGet(`/api/rentengine/completion-rate?period=${period}`),
    apiGet("/api/rentengine/days-on-market"),
    apiGet(`/api/dashboard/move-ins?period=${period}`),
    apiGet("/api/dashboard/avg-days-vacant"),
    apiGet("/api/dashboard/apps-submitted"),
  ]);

  const periodInfo = unwrap(periodInfoResult);
  const occupancy = unwrap(occupancyResult);
  const occupancyHistory = unwrap(occupancyHistoryResult);
  const leaseMix = unwrap(leaseMixResult);
  const delinquency = unwrap(delinquencyResult);
  const renewals = unwrap(renewalsResult);
  const renewalsMonthly = unwrap(renewalsMonthlyResult);
  const renewalRate = unwrap(renewalRateResult);
  const owners = unwrap(ownersResult);
  const rentAndDeposit = unwrap(rentAndDepositResult);
  const delinquencyAging = unwrap(delinquencyAgingResult);
  // /api/dashboard/financials/rent-collection returns { months, yearly,
  // sameMonthLastYear, cachedAt, stale, lastError } (see dashboardRoutes.ts).
  // ADDED 2026-07-09: `months` is now a WIDER window (back ~2 years) AND
  // includes the still-in-progress CURRENT month — its own by-3rd/10th/
  // month-end figures are already correct at every point in the month (a
  // live rolling number before each cutoff passes, the true final number
  // once it does; see the note on this route in dashboardRoutes.ts for why).
  //
  // Two different slices of the same array serve two different purposes:
  // `rentCollection` (chart + sparklines) explicitly excludes the current
  // month, so the 12-MONTH CHART keeps showing only complete months,
  // unchanged from before. `rentCollectionLatest` (the Rent By 3rd/10th
  // TILES) uses the true latest entry, current month included, so those
  // tiles show the most up-to-date number available rather than a stale
  // one — see renderFinancials for the "(so far)" qualifier that keeps
  // this honest about not-yet-passed cutoffs.
  const rentCollectionResponse = unwrap(rentCollectionResult);
  const rentCollectionFull = rentCollectionResponse ? rentCollectionResponse.months : null;
  const now = new Date();
  const currentMonthStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const todayDayOfMonth = now.getUTCDate();
  const rentCollectionComplete = rentCollectionFull ? rentCollectionFull.filter((m) => m.month !== currentMonthStr) : null;
  const rentCollection = rentCollectionComplete ? rentCollectionComplete.slice(-12) : null;
  const rentCollectionLatest =
    rentCollectionFull && rentCollectionFull.length > 0 ? rentCollectionFull[rentCollectionFull.length - 1] : null;
  const isLatestMonthCurrent = rentCollectionLatest ? rentCollectionLatest.month === currentMonthStr : false;
  const rentCollectionYearly = rentCollectionResponse ? rentCollectionResponse.yearly : null;
  const rentCollectionSameMonthLastYear = rentCollectionResponse ? rentCollectionResponse.sameMonthLastYear : null;
  const propertyHealth = unwrap(propertyHealthResult);
  const doors = unwrap(doorsResult);
  const avgTenancy = unwrap(avgTenancyResult);
  const leasingFunnel = unwrap(leasingFunnelResult);
  const prospectsBySource = unwrap(prospectsBySourceResult);
  const unitsOnMarket = unwrap(unitsOnMarketResult);
  const marketingActivity = unwrap(marketingActivityResult);
  const completionRate = unwrap(completionRateResult);
  const daysOnMarket = unwrap(daysOnMarketResult);
  const moveIns = unwrap(moveInsResult);
  const avgDaysVacant = unwrap(avgDaysVacantResult);
  const appsSubmitted = unwrap(appsSubmittedResult);

  contextLine.textContent = periodInfo
    ? `${PERIOD_LABELS[period].toUpperCase()} · ${formatDateRange(
        periodInfo.range
      )} · Flow metrics for this period; structural metrics shown as of today`
    : `${PERIOD_LABELS[period].toUpperCase()} · Flow metrics for this period; structural metrics shown as of today`;

  content.innerHTML = `
    ${renderTopOfMind({ delinquency, occupancy, renewalRate, rentCollection, doors })}
    ${renderFinancials({ rentAndDeposit, delinquencyAging, rentCollection, rentCollectionLatest, isLatestMonthCurrent, todayDayOfMonth, rentCollectionYearly, rentCollectionSameMonthLastYear })}
    ${renderOccupancyAndDoors({ occupancy, occupancyHistory, owners, propertyHealth, doors, avgDaysVacant })}
    ${renderLeasingPipeline({ leaseMix, renewals, renewalsMonthly, avgTenancy, moveIns, appsSubmitted })}
    ${renderMarketingAndShowings({ leasingFunnel, prospectsBySource, unitsOnMarket, marketingActivity, completionRate, daysOnMarket })}
  `;

  wireTileClicks();
}

// Sparklines need a short trend of values. Only the Rent Collection series
// currently has real trailing-12-month history from the backend — used to
// derive an Occupancy/Renewal-flavored sparkline isn't accurate, so
// sparklines below only render for tiles backed by a real trend (Total
// Delinquent has no history endpoint yet either — this returns null and
// tileHtml simply omits the sparkline rather than fabricating one).
function trendFromRentCollection(rentCollection, field) {
  if (!rentCollection || rentCollection.length < 2) return null;
  return rentCollection.map((m) => m[field]);
}

// Promise.allSettled helper: returns the resolved value, or null on
// rejection. Callers check for null and fall back to a per-tile/per-section
// "couldn't load" state instead of the whole tab blanking out.
function unwrap(settledResult) {
  return settledResult.status === "fulfilled" ? settledResult.value : null;
}

// ---------------------------------------------------------------------
// TOP OF MIND
// ---------------------------------------------------------------------

function renderTopOfMind({ delinquency, occupancy, renewalRate, rentCollection, doors }) {
  return `
    <div class="section">
      <p class="section-title">Top of Mind</p>
      <div class="tile-grid">
        ${
          delinquency
            ? tileHtml({
                id: "total-delinquent",
                label: "Total Delinquent",
                value: formatCurrencyPrecise(delinquency.totalOutstandingBalance),
                sub: `${formatNumber(delinquency.delinquentLeaseCount)} leases`,
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "total-delinquent", label: "Total Delinquent", sourceTags: ["BD"] })
        }
        ${
          occupancy
            ? tileHtml({
                id: "occupancy",
                label: "Occupancy",
                value: formatPercent(occupancy.occupancyRatePercent),
                sub: `${formatNumber(occupancy.occupiedUnits)} of ${formatNumber(occupancy.totalUnits)} units`,
                sourceTags: ["BD"],
                live: true,
                clickable: true,
                sparkline: trendFromRentCollection(rentCollection, "paidByThirdPercent")
                  ? { values: trendFromRentCollection(rentCollection, "paidByThirdPercent"), color: "#1e5631" }
                  : null,
              })
            : couldNotLoadTile({ id: "occupancy", label: "Occupancy", sourceTags: ["BD"] })
        }
        ${
          !renewalRate
            ? couldNotLoadTile({ id: "renewal-rate", label: "Renewal Rate", sourceTags: ["BD"] })
            : !renewalRate.synced
            ? tileHtml({
                id: "renewal-rate",
                label: "Renewal Rate",
                sourceTags: ["BD"],
                notConnected: true,
                notConnectedReason: "Not connected yet",
              })
            : tileHtml({
                id: "renewal-rate",
                label: "Renewal Rate",
                value: renewalRate.renewalRatePercent === null ? "—" : formatPercent(renewalRate.renewalRatePercent),
                sub: `${formatNumber(renewalRate.renewedCount)} renewed · ${formatNumber(renewalRate.movedOutCount)} moved out (12mo)`,
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
        }
        ${renderNetDoorsTile(doors)}
      </div>
    </div>
  `;
}

// Net Doors — CORRECTED 2026-07-04, window mismatch FIXED 2026-07-05: this
// used to compare a 90-day "added" count against a 12-month "lost" count —
// REBUILT 2026-07-07: Net Doors is now EXACT, not an estimate-vs-estimate
// subtraction — see summarizeNetDoorsYTD in src/kpi/churn.ts. Jason has his
// own real door counts (units under management) as of Jan 1 each year;
// Net Doors is simply today's real total minus that starting count. The
// vendor's own equivalent tile is labeled "trailing 12 months" but its own
// drill-down admits it's really a ~50-day daily-snapshot diff (its tool
// only started snapshotting 2026-05-18), so it was never a fair target to
// match exactly — this is a genuinely more accurate number instead.
function renderNetDoorsTile(doors) {
  if (!doors) {
    return couldNotLoadTile({ id: "net-doors", label: "Net Doors", sourceTags: ["BD"] });
  }
  const ytd = doors.netDoorsYTD;
  if (!ytd) {
    return tileHtml({ id: "net-doors", label: "Net Doors", sourceTags: ["BD"], notConnected: true });
  }
  const net = ytd.netDoors;
  return tileHtml({
    id: "net-doors",
    label: "Net Doors",
    value: `${net >= 0 ? "+" : ""}${net}`,
    sub: `${formatNumber(ytd.doorsAtStartOfYear)} on ${ytd.sinceDate} → ${formatNumber(ytd.currentTotalDoors)} today`,
    sourceTags: ["BD"],
    live: true,
    clickable: true,
  });
}

// A tile whose backend feed exists but the call failed just now (e.g.
// Buildium unreachable) — distinct from "Not connected yet" (no feed
// exists at all). Reuses the same disconnected tile styling since neither
// case has a real number to show right now, but tells the truth about why.
function couldNotLoadTile({ id, label, sourceTags }) {
  return tileHtml({
    id,
    label,
    sourceTags,
    notConnected: true,
    notConnectedReason: "Couldn't load",
  });
}

// ---------------------------------------------------------------------
// FINANCIALS
// ---------------------------------------------------------------------

function renderFinancials({
  rentAndDeposit,
  delinquencyAging,
  rentCollection,
  rentCollectionLatest,
  isLatestMonthCurrent,
  todayDayOfMonth,
  rentCollectionYearly,
  rentCollectionSameMonthLastYear,
}) {
  // "Rent By 3rd" / "Rent By 10th" tiles show the MOST CURRENT figure
  // available — which, as of 2026-07-09, can be the still-in-progress
  // current month (see the note in loadDashboard for why that's not
  // stale/misleading data). If today hasn't reached a tile's own cutoff
  // day yet, that tile's sub-label says "(so far)" so it's honest about
  // being a live, still-moving number rather than a locked-in final one.
  const latestMonth = rentCollectionLatest;
  const thirdSoFar = isLatestMonthCurrent && todayDayOfMonth < 3;
  const tenthSoFar = isLatestMonthCurrent && todayDayOfMonth < 10;

  const rentByThirdTrend = trendFromRentCollection(rentCollection, "paidByThirdPercent");
  const rentByTenthTrend = trendFromRentCollection(rentCollection, "paidByTenthPercent");

  return `
    <div class="section">
      <p class="section-title">Financials</p>
      <div class="tile-grid">
        ${
          latestMonth
            ? tileHtml({
                id: "rent-by-3rd",
                label: "Rent By 3rd",
                value: formatPercent(latestMonth.paidByThirdPercent),
                sub: `${formatNumber(latestMonth.paidByThirdCount)} of ${formatNumber(latestMonth.totalLeasesDue)} leases${thirdSoFar ? " (so far)" : ""}`,
                sourceTags: ["BD"],
                live: true,
                clickable: true,
                sparkline: rentByThirdTrend ? { values: rentByThirdTrend, color: "#1e5631" } : null,
              })
            : couldNotLoadTile({ id: "rent-by-3rd", label: "Rent By 3rd", sourceTags: ["BD"] })
        }
        ${
          latestMonth
            ? tileHtml({
                id: "rent-by-10th",
                label: "Rent By 10th",
                value: formatPercent(latestMonth.paidByTenthPercent),
                sub: `${formatNumber(latestMonth.paidByTenthCount)} of ${formatNumber(latestMonth.totalLeasesDue)} leases${tenthSoFar ? " (so far)" : ""}`,
                sourceTags: ["BD"],
                live: true,
                clickable: true,
                sparkline: rentByTenthTrend ? { values: rentByTenthTrend, color: "#1e5631" } : null,
              })
            : couldNotLoadTile({ id: "rent-by-10th", label: "Rent By 10th", sourceTags: ["BD"] })
        }
        ${
          rentAndDeposit
            ? tileHtml({
                id: "avg-rent-lease",
                label: "Avg Rent/Lease",
                value: rentAndDeposit.avgRentPerLease === null ? "—" : formatCurrency(rentAndDeposit.avgRentPerLease),
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "avg-rent-lease", label: "Avg Rent/Lease", sourceTags: ["BD"] })
        }
        ${
          rentAndDeposit
            ? tileHtml({
                id: "avg-sd-withheld",
                label: "Avg SD Withheld",
                value:
                  rentAndDeposit.avgSecurityDepositWithheld === null
                    ? "—"
                    : formatCurrency(rentAndDeposit.avgSecurityDepositWithheld),
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "avg-sd-withheld", label: "Avg SD Withheld", sourceTags: ["BD"] })
        }
        ${
          rentAndDeposit
            ? tileHtml({
                id: "avg-sd-withheld-pct",
                label: "Avg SD Withheld %",
                value:
                  rentAndDeposit.avgSecurityDepositWithheldPercent === null
                    ? "—"
                    : formatPercent(rentAndDeposit.avgSecurityDepositWithheldPercent),
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "avg-sd-withheld-pct", label: "Avg SD Withheld %", sourceTags: ["BD"] })
        }
      </div>
      <div class="chart-card">
        <div class="chart-card-title-row">
          <p class="chart-card-title">Rent Collection — 12 Months</p>
          ${
            rentCollection && rentCollection.length > 0
              ? `<span class="chart-legend">
                  <span><span class="chart-legend-swatch" style="background:#1e5631;"></span>By 3rd</span>
                  <span><span class="chart-legend-swatch" style="background:#4a8f5c;"></span>By 10th</span>
                </span>`
              : ""
          }
        </div>
        <div class="rent-collection-layout">
          <div class="rent-collection-chart-col">
            ${renderRentCollectionChart(rentCollection)}
          </div>
          <div class="rent-collection-side-col">
            ${renderRentCollectionSidePanels(rentCollectionSameMonthLastYear, isLatestMonthCurrent ? rentCollectionLatest : null, rentCollectionYearly)}
          </div>
        </div>
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Delinquency Aging</p>
        ${renderDelinquencyAging(delinquencyAging)}
      </div>
    </div>
  `;
}

// Grouped bar chart: % paid by the 3rd and by the 10th for each of the
// trailing 12 months. Built with Chart.js (see /js/charts.js) rather than
// the old plain-text breakdown list, per the visual-parity spec.
function renderRentCollectionChart(rentCollection) {
  if (!rentCollection) {
    return notConnectedBox(
      "Couldn't load",
      "The monthly rent-collection numbers didn't come back from Buildium just now — Total Delinquent above may still be live."
    );
  }
  if (rentCollection.length === 0) {
    return `<p class="loading-text">No rent collection history yet for the trailing 12 months.</p>`;
  }
  return groupedBarChartHtml({
    canvasId: "rent-collection-chart",
    labels: rentCollection.map((m) => formatMonthInitial(m.month)),
    series: [
      { label: "By 3rd", data: rentCollection.map((m) => m.paidByThirdPercent), color: "#1e5631" },
      { label: "By 10th", data: rentCollection.map((m) => m.paidByTenthPercent), color: "#4a8f5c" },
    ],
    yFormat: (v) => `${v}%`,
  });
}

// ADDED 2026-07-09, per Jason directly: small panels to the right of the
// existing 12-month chart — same-calendar-month-last-year, a LIVE current-
// month-so-far rolling number next to it, and a by-year rollup list below.
// All three use a DIFFERENT metric than the chart next to them (rent
// collected by the end of the month, not by the 3rd/10th — see
// paidByMonthEndPercent in rentCollection.ts), so each value is labeled
// with its own month/year rather than assumed obvious from context.
//
// `currentMonthRow` is a plain MonthlyCollectionRate — the same shape as
// every other row in the `months` array — passed in as null by the caller
// unless the latest available month actually IS the current in-progress
// one (see loadDashboard's isLatestMonthCurrent). Its paidByMonthEndPercent
// is already a live "as of today" figure for an in-progress month with no
// special-casing needed (see the note on resolveLeaseBalancesPerMonth in
// rentCollection.ts for why that degeneration happens automatically).
function renderRentCollectionSidePanels(sameMonthLastYear, currentMonthRow, yearly) {
  const sameMonthHtml = sameMonthLastYear
    ? `<div class="rc-side-stat">
        <p class="rc-side-stat-label">${formatMonthLabel(sameMonthLastYear.lastYearMonth)}</p>
        <p class="rc-side-stat-value">${formatPercent(sameMonthLastYear.lastYearPercent)}</p>
      </div>`
    : `<div class="rc-side-stat rc-side-stat-empty">
        <p class="rc-side-stat-label">Same month last year</p>
        <p class="rc-side-stat-value">—</p>
      </div>`;

  const currentMonthHtml =
    currentMonthRow && currentMonthRow.totalLeasesDue > 0
      ? `<div class="rc-side-stat">
          <p class="rc-side-stat-label">${formatMonthLabel(currentMonthRow.month)} (so far)</p>
          <p class="rc-side-stat-value">${formatPercent(currentMonthRow.paidByMonthEndPercent)}</p>
        </div>`
      : `<div class="rc-side-stat rc-side-stat-empty">
          <p class="rc-side-stat-label">This month (so far)</p>
          <p class="rc-side-stat-value">—</p>
        </div>`;

  // Shows the month right alongside the year (e.g. "Jun 2026" rather than a
  // bare "2026") using the LAST month actually included in that year's
  // rollup — for a complete past year this reads as "Dec 2025," for the
  // current year it makes the year-to-date-ness obvious at a glance.
  const yearlyRowsHtml =
    yearly && yearly.length > 0
      ? yearly
          .map(
            (y) =>
              `<div class="rc-yearly-row"><span>${formatMonthLabel(y.lastMonth)}</span><span>${formatPercent(y.paidByMonthEndPercent)}</span></div>`
          )
          .join("")
      : `<p class="rc-side-stat-empty-text">No yearly history yet</p>`;

  return `
    <div class="rc-side-stat-row">
      ${sameMonthHtml}
      ${currentMonthHtml}
    </div>
    <div class="rc-yearly-list">
      <p class="rc-side-panel-title">By Year (Month End)</p>
      ${yearlyRowsHtml}
    </div>
  `;
}

// Delinquency Aging: styled as horizontal filled progress-bar rows (not a
// chart component) per spec — severity color, dollar amount right-aligned
// outside the bar.
function renderDelinquencyAging(delinquencyAging) {
  if (!delinquencyAging) {
    return notConnectedBox(
      "Couldn't load",
      "The 0-30 / 31-60 / 61-90 / 90+ day breakdown didn't come back from Buildium just now — Total Delinquent above may still be live."
    );
  }
  if (delinquencyAging.length === 0) {
    return `<p class="loading-text">No delinquency aging data yet.</p>`;
  }
  const severityColors = ["#e8b567", "#c8791e", "#c23b3b", "#8b1f1f"];
  const rows = delinquencyAging.map((bucket, i) => ({
    label: `${bucket.label} days`,
    value: bucket.totalBalance,
    displayValue: `${formatCurrencyPrecise(bucket.totalBalance)} (${formatNumber(bucket.leaseCount)})`,
    color: severityColors[Math.min(i, severityColors.length - 1)],
  }));
  return horizontalBarListHtml({ rows, className: "aging" });
}

function formatMonthInitial(yyyyMm) {
  const [year, month] = yyyyMm.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, 1));
  return d.toLocaleDateString("en-US", { month: "narrow", timeZone: "UTC" });
}

function formatMonthLabel(yyyyMm) {
  const [year, month] = yyyyMm.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, 1));
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// Converts a "YYYY-MM-DD" string to "M/D/YYYY". Plain string splitting
// (not `new Date(...).toLocaleDateString()`) so this can't shift the day
// by a timezone offset — the input is already a calendar date, not a
// moment in time.
function formatMonthDayYear(yyyyMmDd) {
  const [year, month, day] = yyyyMmDd.split("-");
  return `${Number(month)}/${Number(day)}/${year}`;
}

function formatDayMonthYear(yyyyMmDd) {
  const [year, month, day] = yyyyMmDd.split("-");
  return `${day}/${month}/${year}`;
}

// ---------------------------------------------------------------------
// OCCUPANCY & DOORS
// ---------------------------------------------------------------------

// Total Units "vs last yr" badge — ADDED 2026-07-09, per Jason directly,
// matching the vendor's own "▲ +143.8% vs last yr" badge on their Total
// Units tile. Their exact number doesn't reconcile against any of Jason's
// real Jan-1 door-count anchors (see summarizeTotalUnitsYoY in
// src/kpi/churn.ts), so this uses his own real anchor (doors under
// management as of Jan 1 this year) instead of guessing at their baseline.
function totalUnitsYoyBadge(totalUnitsYoY) {
  if (!totalUnitsYoY) return null;
  const arrow = totalUnitsYoY.direction === "up" ? "▲" : "▼";
  const sign = totalUnitsYoY.percent >= 0 ? "+" : "";
  return { direction: totalUnitsYoY.direction, text: `${arrow} ${sign}${totalUnitsYoY.percent}% vs Jan. 1st` };
}

function renderOccupancyAndDoors({ occupancy, occupancyHistory, owners, propertyHealth, doors, avgDaysVacant }) {
  return `
    <div class="section">
      <p class="section-title">Occupancy &amp; Doors</p>
      <div class="tile-grid">
        ${
          occupancy
            ? tileHtml({
                id: "total-units",
                label: "Total Units",
                value: formatNumber(occupancy.totalUnits),
                sourceTags: ["BD"],
                live: true,
                clickable: true,
                yoy: totalUnitsYoyBadge(occupancy.totalUnitsYoY),
              })
            : couldNotLoadTile({ id: "total-units", label: "Total Units", sourceTags: ["BD"] })
        }
        ${
          occupancy
            ? tileHtml({
                id: "vacant-not-rented",
                label: "Vacant — Not Rented",
                value: formatNumber(occupancy.vacantUnits),
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "vacant-not-rented", label: "Vacant — Not Rented", sourceTags: ["BD"] })
        }
        ${
          avgDaysVacant && avgDaysVacant.avgDaysVacant !== null
            ? tileHtml({
                id: "avg-days-vacant",
                label: "Avg Days Vacant",
                value: formatNumber(avgDaysVacant.avgDaysVacant),
                sub: `Across ${formatNumber(avgDaysVacant.vacantUnitCount)} vacant units`,
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : avgDaysVacant
            ? tileHtml({ id: "avg-days-vacant", label: "Avg Days Vacant", sourceTags: ["BD"], notConnected: true, notConnectedReason: "No vacant units with known history" })
            : couldNotLoadTile({ id: "avg-days-vacant", label: "Avg Days Vacant", sourceTags: ["BD"] })
        }
        ${doorsTile({ doors, id: "doors-added", label: "Doors Added" })}
        ${renderChurnTile(doors)}
        ${
          owners
            ? tileHtml({
                id: "owners",
                label: "Owners",
                value: formatNumber(owners.length),
                sub: "Gained this period: not connected yet",
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "owners", label: "Owners", sourceTags: ["BD"] })
        }
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Occupancy Rate — Year over Year</p>
        ${renderOccupancyTrendChart(occupancyHistory)}
      </div>
      <div class="chart-card">
        <div class="chart-card-title-row">
          <p class="chart-card-title">Property Health</p>
          ${badgeHtml(["RE", "BD"], true)}
        </div>
        ${renderPropertyHealthChart(propertyHealth)}
      </div>
    </div>
  `;
}

// Doors Added / Doors Lost tiles — CORRECTED 2026-07-04: the "permanently
// unavailable" conclusion was wrong. Jason correctly insisted this data
// exists somewhere, and it does — Buildium's owner records carry a
// ManagementAgreementStartDate/EndDate field the earlier research pass
// missed. Doors Added is real, exact, live-computed (30/60/90-day counts).
// Doors Lost is a real but EXPLICITLY ESTIMATED figure (Buildium has no
// exact "date this property was dropped" field; this is derived from the
// most recent lease end date on each currently-inactive property, so it's
// labeled "estimated" rather than "LIVE" and undercounts properties that
// never had a Buildium lease on file — see doors.doorsLostEstimated.note).
function doorsTile({ doors, id, label }) {
  if (!doors) {
    return couldNotLoadTile({ id, label, sourceTags: ["BD"] });
  }
  if (id === "doors-added") {
    if (!doors.doorsAdded) {
      return couldNotLoadTile({ id, label, sourceTags: ["BD"] });
    }
    return tileHtml({
      id,
      label,
      sourceTags: ["BD"],
      value: doors.doorsAdded.doorsAddedYTD,
      sub: `Year to date · ${doors.doorsAdded.doorsAdded30Days} in the last 30 days`,
      pending: "Reflects Buildium's records, which may lag a few days behind a real signing",
      clickable: true,
    });
  }
  if (id === "doors-lost") {
    if (!doors.doorsLostEstimated) {
      return couldNotLoadTile({ id, label, sourceTags: ["BD"] });
    }
    return tileHtml({
      id,
      label,
      sourceTags: ["BD"],
      value: doors.doorsLostEstimated.doorsLostYTD,
      sub: `Year to date (est.) · ${doors.doorsLostEstimated.doorsLost31Days} in the last 31 days`,
      pending: "Estimated from the last known lease date, not an exact deactivation date",
    });
  }
  return couldNotLoadTile({ id, label, sourceTags: ["BD"] });
}

// Occupancy Rate — Year over Year — REBUILT 2026-07-09, per Jason
// directly: "year over year, for each month, as far back as can be
// tracked." Backed by /api/dashboard/occupancy-history (see
// summarizeMonthlyOccupancy in occupancy.ts for how monthly figures this
// far back are reconstructed from real lease coverage, not a snapshot).
// One line per year, overlaid on a Jan-Dec axis via the SAME
// yearOverYearLineChartHtml component already built for this (current
// year highlighted, prior years muted) — plus the same side-panel pair
// used for Rent Collection: a same-calendar-month-last-year callout and a
// by-year average rollup.
function renderOccupancyTrendChart(occupancyHistory) {
  if (!occupancyHistory) {
    return notConnectedBox("Couldn't load", "The occupancy history didn't come back from Buildium just now — current Occupancy tile above may still be live.");
  }
  const months = occupancyHistory.months;
  if (!months || months.length === 0) {
    return `<p class="loading-text">No occupancy history available yet.</p>`;
  }

  const seriesByYear = {};
  for (const m of months) {
    const [year, mm] = m.month.split("-");
    if (!seriesByYear[year]) seriesByYear[year] = new Array(12).fill(null);
    seriesByYear[year][Number(mm) - 1] = m.occupancyPercent;
  }
  const currentYear = new Date().getUTCFullYear();

  const sameMonthLastYear = occupancyHistory.sameMonthLastYear;
  const sameMonthHtml = sameMonthLastYear
    ? `<div class="rc-side-stat">
        <p class="rc-side-stat-label">${formatMonthLabel(sameMonthLastYear.lastYearMonth)}</p>
        <p class="rc-side-stat-value">${formatPercent(sameMonthLastYear.lastYearOccupancyPercent)}</p>
      </div>`
    : `<div class="rc-side-stat rc-side-stat-empty">
        <p class="rc-side-stat-label">Same month last year</p>
        <p class="rc-side-stat-value">—</p>
      </div>`;

  const yearly = occupancyHistory.yearly || [];
  const yearlyRowsHtml =
    yearly.length > 0
      ? yearly
          .map(
            (y) =>
              `<div class="rc-yearly-row"><span>${formatMonthLabel(y.lastMonth)}</span><span>${formatPercent(y.avgOccupancyPercent)}</span></div>`
          )
          .join("")
      : `<p class="rc-side-stat-empty-text">No yearly history yet</p>`;

  return `
    <div class="rent-collection-layout">
      <div class="rent-collection-chart-col">
        ${yearOverYearLineChartHtml({ canvasId: "occupancy-yoy-chart", seriesByYear, currentYear, yFormat: (v) => `${v}%` })}
      </div>
      <div class="rent-collection-side-col">
        <div class="rc-side-stat-row">
          ${sameMonthHtml}
        </div>
        <div class="rc-yearly-list">
          <p class="rc-side-panel-title">By Year (Avg)</p>
          ${yearlyRowsHtml}
        </div>
      </div>
    </div>
  `;
}

// Property Health donut/ring chart with side legend. Wired to the real
// /api/dashboard/property-health route. CORRECTED 2026-07-04, second pass:
// this used to be derived from a Buildium occupancy/delinquency formula
// (which produced 201 properties: 160 Healthy, 25 At-risk, 16 Off-Market).
// Jason found RentEngine's real docs confirming property_health is
// actually a direct RentEngine field on their Reporting API
// (GET /reporting/leasing-performance/units/{id}) — the Buildium formula
// was a coincidence-proof guess, not the real source. Now scoped to
// RentEngine's ~61 tracked units instead (confirmed live: 17 Healthy, 44
// Off-Market for this account today — a genuinely different, smaller
// denominator than the old Buildium-based number, not a regression).
// countsByCategory currently always includes all 6+Unknown keys (some at
// 0), but this renders whatever keys actually come back — not hardcoded to
// 6 — and drops any category with a zero count from the chart/legend so
// the donut and legend don't show a run of empty rows.
function renderPropertyHealthChart(propertyHealth) {
  if (!propertyHealth) {
    return notConnectedBox("Couldn't load", "Property health data didn't come back from Buildium just now.");
  }
  const categories = Object.entries(propertyHealth.countsByCategory || {})
    .map(([label, count]) => ({ label, count }))
    .filter((c) => c.count > 0);
  if (categories.length === 0) {
    return `<p class="loading-text">No property health data yet.</p>`;
  }
  return donutWithLegendHtml({ canvasId: "property-health-chart", categories });
}

// Doors Lost / Churn tile — REBUILT 2026-07-09, per Jason directly: a live
// rolling count + percentage for the current year's churn, shrunk down to
// fit the same tile slot the plain "Doors Lost / Churn" tile used to
// occupy (previously this was its own full-width chart-card below —
// Jason asked for it moved back into the tile grid instead). The compact
// "by year" line reuses summarizeChurnByYear's real Jan-1 door-count
// anchors (src/kpi/churn.ts) as each year's denominator.
function renderChurnTile(doors) {
  if (!doors) {
    return couldNotLoadTile({ id: "doors-lost", label: "Doors Lost / Churn", sourceTags: ["BD"] });
  }
  const churnByYear = doors.churnByYear;
  const currentYearRow = churnByYear && churnByYear.find((y) => y.isCurrentYear);
  if (!currentYearRow) {
    return couldNotLoadTile({ id: "doors-lost", label: "Doors Lost / Churn", sourceTags: ["BD"] });
  }
  const previousYears = churnByYear.filter((y) => !y.isCurrentYear);
  const historyHtml =
    previousYears.length > 0
      ? previousYears
          .map((y) => `<div class="churn-tile-year-row"><span>${y.year}</span><span>${formatPercent(y.churnPercent)}</span></div>`)
          .join("")
      : "";

  return `
    <div class="tile">
      <div class="tile-top">
        <span class="tile-label">Doors Lost / Churn</span>
        ${badgeHtml(["BD"], true)}
      </div>
      <div class="churn-tile-body">
        <div class="tile-value">${formatNumber(currentYearRow.doorsLost)}</div>
        ${historyHtml ? `<div class="churn-tile-history">${historyHtml}</div>` : ""}
      </div>
      <div class="tile-yoy up">${formatPercent(currentYearRow.churnPercent)} churn · ${currentYearRow.year} so far</div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// LEASING PIPELINE
// ---------------------------------------------------------------------

function renderLeasingPipeline({ leaseMix, renewals, renewalsMonthly, avgTenancy, moveIns, appsSubmitted }) {
  return `
    <div class="section">
      <p class="section-title">Leasing Pipeline</p>
      <div class="tile-grid">
        ${
          renewals
            ? tileHtml({
                id: "renewals",
                label: "Renewals",
                value: formatNumber(renewals.length),
                sub: "Trailing 12 months",
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "renewals", label: "Renewals", sourceTags: ["BD"] })
        }
        ${
          leaseMix
            ? tileHtml({
                id: "fixed-term-leases",
                label: "Fixed-Term Leases",
                value: formatNumber(leaseMix.fixedTermCount),
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "fixed-term-leases", label: "Fixed-Term Leases", sourceTags: ["BD"] })
        }
        ${
          leaseMix
            ? tileHtml({
                id: "month-to-month",
                label: "Month-to-Month",
                value: formatNumber(leaseMix.monthToMonthCount),
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "month-to-month", label: "Month-to-Month", sourceTags: ["BD"] })
        }
        ${
          appsSubmitted
            ? tileHtml({
                id: "apps-submitted",
                label: "Apps Submitted",
                value: formatNumber(appsSubmitted.appsSubmitted),
                sub: "Awaiting a decision",
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "apps-submitted", label: "Apps Submitted", sourceTags: ["BD"] })
        }
        ${
          moveIns
            ? tileHtml({
                id: "move-ins",
                label: "Move-Ins",
                value: formatNumber(moveIns.moveIns),
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "move-ins", label: "Move-Ins", sourceTags: ["BD"] })
        }
        ${
          appsSubmitted && moveIns && moveIns.moveIns > 0
            ? tileHtml({
                id: "apps-per-move-in",
                label: "Apps Per Vacancy",
                value: (appsSubmitted.appsSubmitted / moveIns.moveIns).toFixed(1),
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "apps-per-move-in", label: "Apps Per Vacancy", sourceTags: ["BD"] })
        }
        ${
          leaseMix
            ? tileHtml({
                id: "evictions-pending",
                label: "Evictions Pending",
                value: formatNumber(leaseMix.evictionPendingCount),
                sourceTags: ["BD"],
                live: true,
                clickable: true,
                alert: true,
              })
            : couldNotLoadTile({ id: "evictions-pending", label: "Evictions Pending", sourceTags: ["BD"] })
        }
        ${
          avgTenancy
            ? tileHtml({
                id: "avg-tenancy",
                label: "Avg Tenancy",
                value: avgTenancy.avgTenancyMonths === null ? "—" : `${formatNumber(avgTenancy.avgTenancyMonths)} mo`,
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "avg-tenancy", label: "Avg Tenancy", sourceTags: ["BD"] })
        }
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Renewals — Trailing 12 Mo</p>
        ${renderRenewalsMonthlyChart(renewalsMonthly)}
      </div>
    </div>
  `;
}

// ADDED 2026-07-13, per Jason directly: this chart card was still showing
// the "Not connected yet" placeholder even though the Renewals tile right
// next to it is live — emphasizedBarChartHtml (public/js/charts.js) was
// already built for exactly this chart and just never wired up. Same
// "renewed" population as the Renewals tile above, one bar per calendar
// month, most recent month emphasized.
function renderRenewalsMonthlyChart(renewalsMonthly) {
  if (!renewalsMonthly) {
    return notConnectedBox("Couldn't load", "The monthly renewal counts didn't come back just now — Renewals tile above may still be live.");
  }
  if (renewalsMonthly.length === 0) {
    return `<p class="loading-text">No renewal history available yet.</p>`;
  }
  return emphasizedBarChartHtml({
    canvasId: "renewals-monthly-chart",
    labels: renewalsMonthly.map((m) => formatMonthInitial(m.month)),
    data: renewalsMonthly.map((m) => m.count),
  });
}

// ---------------------------------------------------------------------
// MARKETING & SHOWINGS
// ---------------------------------------------------------------------

// Wired to real RentEngine routes as of 2026-07-04:
//   - leasingFunnel: /api/rentengine/leasing-funnel — Prospects, Showings
//     scheduled/completed, Applications, Move-ins for the selected period.
//   - prospectsBySource: /api/rentengine/prospects-by-source — arbitrary
//     list of normalized source names, not hardcoded.
//   - unitsOnMarket: /api/rentengine/units-on-market — totalUnitsTracked
//     (a RentEngine-tracked subset, not the full Buildium portfolio).
//   - marketingActivity: /api/rentengine/marketing-activity — New
//     Prospects is live; Total Calls/Outbound Texts depend on a background
//     sync job and read as "Not connected yet" (real dashed-border
//     wording, since this WILL show a number once that sync completes)
//     until callActivitySynced is true.
//   - completionRate: /api/rentengine/completion-rate (SPLIT OFF
//     marketing-activity 2026-07-13, per Jason directly) — scoped to units
//     actually available for showing (status not Leased/On Hold/
//     Incomplete), confirmed against the vendor's own drill-down. The old
//     blanket version (every tracked unit, Leased included) undercounted
//     the real rate — 31.9% (44/138) here vs the vendor's scoped 59.6%
//     (28/47) on the same day.
//   - daysOnMarket: /api/rentengine/days-on-market — CORRECTED 2026-07-04,
//     real and live via RentEngine's Reporting API (was wrongly marked
//     unavailable before; Jason was right to push back).
// FIXED 2026-07-04: "Showings Completed" used to read funnel.showingsCompleted
// (summarizeLeasingFunnel in src/rentengine/client.ts), which buckets a
// prospect toward showingsCompleted if they ever REACHED a later-stage
// status (Application Received, Approved, etc) — a funnel-reachability
// count, not "showings that actually happened this period." Confirmed live
// 2026-07-04 against the vendor site side-by-side: that produced 21 vs the
// vendor's real 11. marketingActivity.showingsCompleted (already fetched on
// this same page for the Total Calls/Outbound Texts tiles) comes from
// RentEngine's real Reporting API (showings_completed field, period-scoped,
// summed across units) and matches the vendor's number — this tile now
// reads from there instead.
function renderMarketingAndShowings({ leasingFunnel, prospectsBySource, unitsOnMarket, marketingActivity, completionRate, daysOnMarket }) {
  return `
    <div class="section">
      <p class="section-title">Marketing &amp; Showings</p>
      <div class="tile-grid">
        ${renderDaysOnMarketTile(daysOnMarket, "avgDaysOnMarket", "avg-dom", "Avg Days on Market")}
        ${renderDaysOnMarketTile(daysOnMarket, "medianDaysOnMarket", "median-dom", "Median DOM")}
        ${
          unitsOnMarket && unitsOnMarket.connected
            ? tileHtml({
                id: "units-on-market",
                label: "Units on Market",
                value: formatNumber(unitsOnMarket.unitsOnMarket),
                sub: `of ${formatNumber(unitsOnMarket.totalUnitsTracked)} RE-tracked units`,
                sourceTags: ["RE"],
                live: true,
                clickable: true,
              })
            : unitsOnMarket && !unitsOnMarket.connected
            ? tileHtml({ id: "units-on-market", label: "Units on Market", sourceTags: ["RE"], notConnected: true })
            : couldNotLoadTile({ id: "units-on-market", label: "Units on Market", sourceTags: ["RE"] })
        }
        ${
          completionRate && completionRate.connected && completionRate.ratePercent !== null
            ? tileHtml({
                id: "completion-rate",
                label: "Completion Rate",
                value: formatPercent(completionRate.ratePercent),
                sub: `${formatNumber(completionRate.showingsCompleted)} of ${formatNumber(
                  completionRate.showingsScheduled
                )} showings`,
                sourceTags: ["RE"],
                live: true,
                clickable: true,
              })
            : completionRate && !completionRate.connected
            ? tileHtml({ id: "completion-rate", label: "Completion Rate", sourceTags: ["RE"], notConnected: true })
            : couldNotLoadTile({ id: "completion-rate", label: "Completion Rate", sourceTags: ["RE"] })
        }
        ${
          marketingActivity && marketingActivity.connected
            ? tileHtml({
                id: "new-prospects",
                label: "New Prospects",
                value: formatNumber(marketingActivity.newProspects),
                sourceTags: ["RE"],
                live: true,
                clickable: true,
              })
            : marketingActivity && !marketingActivity.connected
            ? tileHtml({ id: "new-prospects", label: "New Prospects", sourceTags: ["RE"], notConnected: true })
            : couldNotLoadTile({ id: "new-prospects", label: "New Prospects", sourceTags: ["RE"] })
        }
        ${
          marketingActivity && marketingActivity.connected
            ? tileHtml({
                id: "showings-completed",
                label: "Showings Completed",
                value: formatNumber(marketingActivity.showingsCompleted),
                sourceTags: ["RE"],
                live: true,
                clickable: true,
              })
            : marketingActivity && !marketingActivity.connected
            ? tileHtml({ id: "showings-completed", label: "Showings Completed", sourceTags: ["RE"], notConnected: true })
            : couldNotLoadTile({ id: "showings-completed", label: "Showings Completed", sourceTags: ["RE"] })
        }
        ${renderCallActivityTile(marketingActivity, "totalCalls", "total-calls", "Total Calls")}
        ${renderCallActivityTile(marketingActivity, "outboundTexts", "outbound-texts", "Outbound Texts")}
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Leasing Funnel${leasingFunnelRangeSuffix(leasingFunnel)}</p>
        ${renderLeasingFunnelChart(leasingFunnel)}
      </div>
      <div class="chart-card">
        <p class="chart-card-title">New Prospects by Source</p>
        ${renderProspectsBySourceChart(prospectsBySource)}
      </div>
    </div>
  `;
}

// Days on Market / Median DOM — CORRECTED 2026-07-04: the earlier
// "permanently unavailable" conclusion was wrong. Jason correctly insisted
// this is a real, important RentEngine metric, and it is — just not on the
// plain /units endpoint checked before. It comes from RentEngine's real
// Reporting API (GET /reporting/leasing-performance/units/{id}), found via
// RentEngine's own public docs. Scoped to RentEngine's ~61 tracked units,
// not the full Buildium portfolio (see unitsWithData/unitsTotal).
function renderDaysOnMarketTile(daysOnMarket, field, id, label) {
  if (!daysOnMarket) {
    return couldNotLoadTile({ id, label, sourceTags: ["RE"] });
  }
  if (!daysOnMarket.connected) {
    return tileHtml({ id, label, sourceTags: ["RE"], notConnected: true });
  }
  const value = daysOnMarket[field];
  if (value === null || value === undefined) {
    return tileHtml({
      id,
      label,
      sourceTags: ["RE"],
      notConnected: true,
      notConnectedReason: "No data yet",
    });
  }
  return tileHtml({
    id,
    label,
    value: formatNumber(value),
    sub: `${daysOnMarket.unitsWithData} of ${daysOnMarket.unitsTotal} on market`,
    sourceTags: ["RE"],
    live: true,
    clickable: true,
  });
}

// Total Calls / Outbound Texts depend on a background sync job
// (POST /api/sync/call-activity) that may still be populating — this is a
// genuine "not connected yet" (dashed border), since it WILL show a real
// number once that sync completes, unlike Days on Market above.
// Only Total Calls is clickable — Outbound Texts intentionally has no
// drill-down (see the note above fetchCallsReport's caller in
// rentEngineRoutes.ts: no bulk texts/messages report endpoint exists in
// RentEngine's Reporting API, only a one-call-per-prospect endpoint that
// would reintroduce the N+1 problem this whole aggregation was built to
// avoid).
function renderCallActivityTile(marketingActivity, field, id, label) {
  if (!marketingActivity) {
    return couldNotLoadTile({ id, label, sourceTags: ["RE"] });
  }
  if (!marketingActivity.connected) {
    return tileHtml({ id, label, sourceTags: ["RE"], notConnected: true });
  }
  if (!marketingActivity.callActivitySynced) {
    return tileHtml({
      id,
      label,
      sourceTags: ["RE"],
      notConnected: true,
      notConnectedReason: "Not connected yet",
    });
  }
  return tileHtml({
    id,
    label,
    value: formatNumber(marketingActivity[field]),
    sourceTags: ["RE"],
    live: true,
    clickable: id === "total-calls",
  });
}

function leasingFunnelRangeSuffix(leasingFunnel) {
  if (!leasingFunnel || !leasingFunnel.connected) return "";
  // RentEngine's account history only goes back to 2026-02-11 — this
  // reports the ACTUAL requested range rather than a hardcoded "Last 12
  // Months" label, so the chart title never implies more history exists
  // than RentEngine actually has for this account.
  const from = leasingFunnel.requestedFrom ? leasingFunnel.requestedFrom.slice(0, 10) : null;
  const to = leasingFunnel.requestedTo ? leasingFunnel.requestedTo.slice(0, 10) : null;
  return from && to ? ` — ${from} to ${to}` : "";
}

// Leasing Funnel — list of stages, each with a horizontal bar whose WIDTH
// is proportional to that stage's count relative to the top stage
// (Prospects). CHANGED 2026-07-13, per Jason directly:
//   - Each stage after the first now shows its count as a % of the
//     PREVIOUS stage (not a period-over-period comparison, which the old
//     comment here wrongly assumed this was) — matches the vendor's own
//     chart exactly (e.g. Showings scheduled as a % of Prospects). All 5
//     numbers are already on hand, so this is just arithmetic, no new
//     data. Shown in muted "neutral" styling, not green/red up/down,
//     since a stage being e.g. 154% of the one before it isn't a
//     good/bad signal — it just means some prospects reach a later stage
//     without every step being logged in between.
//   - Colored with shades of the Limehouse brand green (limeGreenShade),
//     same treatment as New Prospects by Source, instead of one flat
//     blue.
//   - Each bar is now clickable (see handleTileClick below), matching the
//     vendor's own chart, which opens the real prospect list behind each
//     stage's count.
function renderLeasingFunnelChart(leasingFunnel) {
  if (!leasingFunnel) {
    return notConnectedBox("Couldn't load", "The leasing funnel numbers didn't come back from RentEngine just now.");
  }
  if (!leasingFunnel.connected) {
    return notConnectedBox("Not connected yet", "Needs RentEngine access for Prospects → Showings → Applications → Move-ins.");
  }
  const funnel = leasingFunnel.funnel;
  const stages = [
    { label: "Prospects", value: funnel.prospects, tileId: "leasing-funnel-prospects" },
    { label: "Showings scheduled", value: funnel.showingsScheduled, tileId: "leasing-funnel-showings-scheduled" },
    { label: "Showings completed", value: funnel.showingsCompleted, tileId: "leasing-funnel-showings-completed" },
    { label: "Applications", value: funnel.applications, tileId: "leasing-funnel-applications" },
    { label: "Move-ins", value: funnel.moveIns, tileId: "leasing-funnel-move-ins" },
  ];
  if (stages.every((s) => s.value === 0)) {
    return `<p class="loading-text">No leasing activity in RentEngine for this period yet.</p>`;
  }
  const total = stages.length;
  return horizontalBarListHtml({
    rows: stages.map((s, i) => {
      const previous = i > 0 ? stages[i - 1].value : null;
      const change = previous
        ? { direction: "neutral", text: `${Math.round((s.value / previous) * 100)}% ↓` }
        : null;
      return {
        label: s.label,
        value: s.value,
        displayValue: formatNumber(s.value),
        color: limeGreenShade(i, total),
        change,
        tileId: s.tileId,
      };
    }),
  });
}

// Shades of the Limehouse brand green (same hue as --lime-green in
// dashboard.css, derived from the logo) instead of the vendor's
// green/blue/gray scheme — CHANGED 2026-07-13, per Jason directly: "use
// our company colors ... with varying similar shades." Darkest shade goes
// on the top (largest) source, lightening down the list, so rank still
// reads visually — same effect the vendor's green-then-fading-grays
// achieved, just built from one brand hue instead of borrowing several.
// Scales to any row count (RentEngine returns however many sources
// actually have activity — currently 8, up to 12 seen on the vendor site)
// rather than a hardcoded palette running out.
function limeGreenShade(index, total) {
  const hue = 140;
  const saturation = 45;
  const minLightness = 20; // near --lime-green-dark
  const maxLightness = 72; // pale mint, still readably green
  const t = total > 1 ? index / (total - 1) : 0;
  const lightness = minLightness + t * (maxLightness - minLightness);
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

// New Prospects by Source — horizontal bars, one row per source. Handles
// an ARBITRARY/variable list of sources (RentEngine returns however many
// actually have activity for this account) rather than a hardcoded list.
// Sources come back pre-sorted by count from summarizeProspectsBySource on
// the server.
function renderProspectsBySourceChart(prospectsBySource) {
  if (!prospectsBySource) {
    return notConnectedBox("Couldn't load", "Prospect source data didn't come back from RentEngine just now.");
  }
  if (!prospectsBySource.connected) {
    return notConnectedBox("Not connected yet", "Needs RentEngine access to break prospects down by source.");
  }
  if (!prospectsBySource.sources || prospectsBySource.sources.length === 0) {
    return `<p class="loading-text">No prospects recorded in RentEngine for this period yet.</p>`;
  }
  const total = prospectsBySource.sources.length;
  return horizontalBarListHtml({
    rows: prospectsBySource.sources.map((s, i) => ({
      label: s.source,
      value: s.count,
      displayValue: formatNumber(s.count),
      color: limeGreenShade(i, total),
    })),
  });
}

// ---------------------------------------------------------------------
// Drill-downs
// ---------------------------------------------------------------------

function wireTileClicks() {
  document.querySelectorAll("[data-tile-id]").forEach((el) => {
    el.addEventListener("click", () => handleTileClick(el.dataset.tileId));
  });
}

async function handleTileClick(tileId) {
  if (tileId === "total-delinquent") {
    openLoadingModal("Total Delinquent");
    try {
      const rows = await apiGet("/api/dashboard/delinquency/leases");
      openDrillDownModal({
        title: "Total Delinquent",
        columns: [
          { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
          { label: "Unit", key: "unitNumber" },
          {
            label: "Balance",
            render: (r) => formatCurrencyPrecise(r.balance),
          },
        ],
        rows,
        emptyText: "No delinquent leases right now.",
      });
    } catch (err) {
      openDrillDownModal({ title: "Total Delinquent", columns: [], rows: [], emptyText: `Couldn't load: ${err.message}` });
    }
    return;
  }

  if (tileId === "occupancy") {
    openLoadingModal("Occupancy — Vacant Units");
    try {
      const [properties] = await Promise.all([apiGet("/api/dashboard/properties")]);
      openDrillDownModal({
        title: "Properties",
        columns: [
          { label: "Property", key: "name" },
          { label: "Units", key: "numberUnits" },
        ],
        rows: properties,
        emptyText: "No properties found.",
      });
    } catch (err) {
      openDrillDownModal({ title: "Occupancy", columns: [], rows: [], emptyText: `Couldn't load: ${err.message}` });
    }
    return;
  }

  // Renewals — REPLACED 2026-07-13, per Jason directly, to match the
  // vendor's own "Renewals" tile exactly: leases that ALREADY renewed in
  // the trailing 12 months (same population as the "renewed" half of
  // Renewal Rate below), not leases coming up for renewal in the next 60
  // days. See src/kpi/leaseRows.ts's renewalRateRows.
  if (tileId === "renewals") {
    await simpleDrillDown({
      tileId,
      title: "Renewals — Trailing 12 Months",
      url: "/api/dashboard/renewals",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "From", render: (r) => (r.fromDate ? formatDayMonthYear(r.fromDate) : "—") },
        { label: "To", render: (r) => (r.toDate ? formatDayMonthYear(r.toDate) : "—") },
      ],
      emptyText: "No renewals in the trailing 12 months — trigger a Renewal Rate sync first if this looks wrong.",
    });
    return;
  }

  // Renewal Rate — the SAME trailing-12-month population as Renewals above,
  // plus the "moved out" side too (with an Outcome column to tell them
  // apart), since the rate itself needs both halves to compute a percentage.
  if (tileId === "renewal-rate") {
    await simpleDrillDown({
      tileId,
      title: "Renewal Rate — Trailing 12 Months",
      url: "/api/dashboard/renewal-rate/leases",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Outcome", render: (r) => (r.outcome === "renewed" ? "Renewed" : "Moved Out") },
        { label: "From", render: (r) => (r.fromDate ? formatDayMonthYear(r.fromDate) : "—") },
        { label: "To", render: (r) => (r.toDate ? formatDayMonthYear(r.toDate) : "—") },
      ],
      emptyText: "No renewal/move-out activity in the trailing 12 months — trigger a Renewal Rate sync first if this looks wrong.",
    });
    return;
  }

  const period = getStoredPeriod();

  if (tileId === "net-doors") {
    await simpleDrillDown({
      tileId,
      title: "Net Doors — individual door changes are estimated; the tile total above is exact",
      url: "/api/dashboard/net-doors/properties",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Type", render: (r) => (r.type === "added" ? "Added (est.)" : "Lost (est.)") },
        { label: "Date", key: "date" },
      ],
      emptyText: "No door changes in the tracked windows.",
    });
    return;
  }

  // Doors Added — ADDED 2026-07-09, matching the vendor's own "Doors
  // added" drill-down format (header, count line, note box, Property/Doors
  // columns). Scoped to the SAME year-to-date window as the tile's own
  // number (doorsAddedYTD) — NOT the vendor's trailing-12-month window,
  // which their own note admits is really just a day-over-day snapshot
  // diff with only a few weeks of real history behind it (their note says
  // as much: "the trailing-12-month baseline will be reached once
  // snapshots have accumulated for a full year"). Ours is a real, exact
  // figure from day one instead.
  const DOORS_ADDED_NOTE =
    "For each property, we use Buildium's real management-agreement start date (or the property's earliest lease date, if that's actually earlier — some agreements get re-signed years later without the door ever changing hands). A property counts as \"added\" if that start date falls within this calendar year. This is an exact figure, not an estimate.";

  if (tileId === "doors-added") {
    const year = new Date().getFullYear();
    await simpleDrillDown({
      tileId,
      title: "Doors added (year to date)",
      subtitle: (rows) => `${rows.length} doors across ${rows.length} properties (since Jan 1, ${year})`,
      note: DOORS_ADDED_NOTE,
      url: "/api/dashboard/doors-added/properties",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Doors", key: "doors" },
      ],
      emptyText: "No doors added so far this year.",
    });
    return;
  }

  // ADDED 2026-07-07, per Jason directly: a plain-English note explaining
  // how this number is put together, same idea as the vendor site's own
  // "NOTE" box on tiles that aren't a simple live count. See
  // LATE_BALANCE_THRESHOLD / LATE_CUTOFF_DAY_OVERRIDE_BY_LEASE_ID in
  // src/kpi/rentCollection.ts for the actual logic this note describes.
  const RENT_BY_CUTOFF_NOTE =
    "For each active lease, we check Buildium's real payment ledger and calculate how much rent is still owed as of the cutoff date. A lease only counts as late once more than $200 is still outstanding — a tenant short $20–$75 isn't flagged as late. Bounced (NSF) payments are handled correctly: if a payment bounces, the balance goes back to being owed until a real payment replaces it. One inherited lease (3631 Chase Court) has its own late fee policy and isn't considered late until after the 5th instead of the 3rd — more will be added here as they're confirmed.";

  if (tileId === "rent-by-3rd" || tileId === "rent-by-10th") {
    await simpleDrillDown({
      tileId,
      title: tileId === "rent-by-3rd" ? "Rent By 3rd — 12 Months" : "Rent By 10th — 12 Months",
      url: "/api/dashboard/financials/rent-collection",
      rowsKey: "months",
      note: RENT_BY_CUTOFF_NOTE,
      columns:
        tileId === "rent-by-3rd"
          ? [
              { label: "Month", render: (r) => formatMonthLabel(r.month) },
              { label: "Leases Due", key: "totalLeasesDue" },
              { label: "Paid By 3rd", key: "paidByThirdCount" },
              { label: "% By 3rd", render: (r) => formatPercent(r.paidByThirdPercent) },
            ]
          : [
              { label: "Month", render: (r) => formatMonthLabel(r.month) },
              { label: "Leases Due", key: "totalLeasesDue" },
              { label: "Paid By 10th", key: "paidByTenthCount" },
              { label: "% By 10th", render: (r) => formatPercent(r.paidByTenthPercent) },
            ],
      emptyText: "No rent collection history yet for the trailing 12 months.",
    });
    return;
  }

  if (tileId === "avg-rent-lease") {
    await simpleDrillDown({
      tileId,
      title: "Avg Rent/Lease",
      url: "/api/dashboard/financials/rent-and-deposit/leases",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Tenant", key: "tenantName" },
        { label: "Rent", render: (r) => formatCurrency(r.rent) },
      ],
      emptyText: "No active leases with a known rent amount.",
    });
    return;
  }

  // Avg SD Withheld / Avg SD Withheld % — REBUILT 2026-07-10, matching the
  // vendor's own real methodology (see summarizeSecurityDepositWithheld in
  // src/kpi/rentCollection.ts for the full derivation). Both tiles share
  // the same underlying reconciled-move-out list, same note, same drill-
  // down — they're just two different aggregations (plain average vs.
  // ratio-of-sums) over the same rows, so a single drill-down for both
  // tiles avoids ever showing two different lists for what's really one
  // dataset.
  const SD_WITHHELD_NOTE =
    "For each lease that moved out in the trailing window (13 months ago through 30 days ago — recent enough to matter, old enough that the reconciliation has likely been posted), we look for a real move-out reconciliation transaction in Buildium (an \"Applied Deposit\" transaction whose memo says the deposit was applied to balances — Buildium also uses \"Applied Deposit\" for unrelated monthly prepayments, which are excluded). A lease is only included once that reconciliation has actually been posted — a lease with no reconciliation yet is left out, not shown as $0/0%. The withheld amount is capped at the lease's own deposit amount. The dollar figure is a plain average across these leases; the percent figure is the total withheld divided by the total deposits (not an average of each lease's own percentage).";

  if (tileId === "avg-sd-withheld" || tileId === "avg-sd-withheld-pct") {
    await simpleDrillDown({
      tileId,
      title: "Avg SD Withheld — Move-Outs, Trailing ~12 Months",
      url: "/api/dashboard/financials/security-deposit-withheld/leases",
      note: SD_WITHHELD_NOTE,
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Move-out", key: "moveOutDate" },
        { label: "SD", render: (r) => formatCurrencyPrecise(r.securityDeposit) },
        { label: "Withheld", render: (r) => formatCurrencyPrecise(r.withheld) },
        { label: "%", render: (r) => formatPercent(r.percent) },
      ],
      emptyText: "No reconciled move-outs in the trailing window yet — trigger a Security Deposit Withheld sync first if this looks wrong.",
    });
    return;
  }

  // Owners drill-down — ADDED 2026-07-12, per Jason directly. Matches the
  // vendor site's own "All owners" columns (Owner/Active/Start/End), plus
  // a Properties column he asked for that the vendor's drill-down doesn't
  // have. Each row here is already a deduped real owner (co-owner records
  // on the same property, and the same owner using a different name/LLC
  // on a different property, are merged server-side — see
  // src/kpi/owners.ts) — not a raw Buildium owner record.
  if (tileId === "owners") {
    await simpleDrillDown({
      tileId,
      title: "Owners",
      url: "/api/dashboard/owners/list",
      columns: [
        { label: "Owner", key: "name" },
        { label: "Active", render: (r) => (r.active ? "yes" : "no") },
        { label: "Start", render: (r) => r.start ?? "—" },
        { label: "End", render: (r) => r.end ?? "—" },
        { label: "Properties", render: (r) => r.properties.join(", ") },
      ],
      emptyText: "No owners found.",
    });
    return;
  }

  if (tileId === "apps-submitted") {
    await simpleDrillDown({
      tileId,
      title: "Apps Submitted",
      url: "/api/dashboard/apps-submitted/list",
      columns: [
        { label: "Applicant", key: "applicantName" },
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", render: (r) => r.unitNumber ?? "—" },
        { label: "Status", key: "status" },
        { label: "Submitted", render: (r) => (r.submittedDate ? formatMonthDayYear(r.submittedDate.slice(0, 10)) : "—") },
      ],
      emptyText: "No applications awaiting a decision right now.",
    });
    return;
  }

  // Apps Per Vacancy — ADDED 2026-07-12, per Jason directly. A genuinely
  // different, more detailed view than the tile's own headline ratio
  // above (currently-pending applications ÷ move-ins this period, left
  // unchanged) — see src/kpi/vacancyApplications.ts for the full
  // derivation. Every real vacancy cycle in the last 5 years, one row
  // each, with how many applications came in during that specific window.
  const APPS_PER_VACANCY_NOTE =
    "Each row is one real vacancy — the gap between a tenant moving out and the next one moving in, going back 5 years, for every active property. The start date uses whichever real signal is earliest: the outgoing tenant's actual notice-given date (real applications for the next tenant routinely start coming in the moment notice is given, not on the day the old lease technically ends), Buildium's real listing date for a property currently vacant and listed, or the lease's own end date as the fallback. For a vacancy older than Buildium's own lease history for that unit, a real LeadSimple Marketing Process record can anchor an extra row on its own — this can't reach earlier than mid-2022, since that's when LeadSimple's marketing workflow itself started. \"Applications\" counts every application submitted during that window, regardless of outcome (approved, denied, or withdrawn all count as real interest) — this is a different, more detailed number than the ratio shown on the tile itself. Each property gets one row, with its Vacancy/Applications column pairs ordered newest to oldest, left to right.";

  if (tileId === "apps-per-move-in") {
    // Uses a custom fetch instead of simpleDrillDown because the number of
    // "Vacancy"/"Applications" column pairs is data-dependent (as many
    // pairs as the property with the most vacancy cycles needs) — decided
    // per Jason directly, so each vacancy gets its own pair of real
    // columns instead of one combined text column.
    openLoadingModal("Apps Per Vacancy");
    try {
      const rows = await apiGet("/api/dashboard/apps-per-move-in/list");
      const maxVacancies = rows.reduce((max, r) => Math.max(max, r.vacancies.length), 0);
      const columns = [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", render: (r) => r.unitNumber ?? "—" },
      ];
      for (let i = 0; i < maxVacancies; i++) {
        columns.push({
          label: "Vacancy",
          render: (r) => {
            const v = r.vacancies[i];
            if (!v) return "—";
            const end = v.end ? formatMonthDayYear(v.end) : "Ongoing";
            return `${formatMonthDayYear(v.start)}–${end}`;
          },
        });
        columns.push({
          label: "Applications",
          render: (r) => r.vacancies[i]?.applicationCount ?? "—",
        });
      }
      openDrillDownModal({
        title: "Apps Per Vacancy",
        note: APPS_PER_VACANCY_NOTE,
        columns,
        rows,
        emptyText: "No vacancy cycles found in the last 5 years.",
      });
    } catch (err) {
      openDrillDownModal({ title: "Apps Per Vacancy", columns: [], rows: [], emptyText: `Couldn't load: ${err.message}` });
    }
    return;
  }

  if (tileId === "total-units") {
    await simpleDrillDown({
      tileId,
      title: "Total Units",
      url: "/api/dashboard/units",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Status", render: (r) => (r.occupied ? "Occupied" : "Vacant") },
      ],
      emptyText: "No units found.",
    });
    return;
  }

  if (tileId === "vacant-not-rented") {
    await simpleDrillDown({
      tileId,
      title: "Vacant (no future lease)",
      subtitle: (rows) => `${rows.length} vacant`,
      url: "/api/dashboard/units/vacant",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
      ],
      emptyText: "No vacant units right now.",
    });
    return;
  }

  // Matches the vendor's own "Vacant units" drill-down format: header,
  // then a subtitle line right below it with "Avg N days · N vacant (N
  // with prior leases)". Uses OUR OWN vacant-unit count (IsUnitOccupied,
  // same as the Vacant — Not Rented tile) rather than the vendor's — their
  // own drill-down shows a DIFFERENT, larger vacant count here (31) than
  // their own Vacant — Not Rented tile (19), a real inconsistency on their
  // site between two tiles that both claim to count "vacant units."
  // "Never rented" (their exact wording) replaces a null daysVacant, same
  // as their display for units with no lease history at all.
  if (tileId === "avg-days-vacant") {
    await simpleDrillDown({
      tileId,
      title: "Vacant units",
      subtitle: (rows) => {
        const withHistory = rows.filter((r) => r.daysVacant !== null);
        const avg = withHistory.length > 0 ? Math.round(withHistory.reduce((sum, r) => sum + r.daysVacant, 0) / withHistory.length) : null;
        return `Avg ${avg === null ? "—" : avg} days · ${rows.length} vacant (${withHistory.length} with prior leases)`;
      },
      url: "/api/dashboard/avg-days-vacant/units",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Days Vacant", render: (r) => (r.daysVacant === null ? "Never rented" : r.daysVacant) },
      ],
      emptyText: "No vacant units right now.",
    });
    return;
  }

  if (tileId === "fixed-term-leases") {
    await simpleDrillDown({
      tileId,
      title: "Fixed-Term Leases",
      url: "/api/dashboard/lease-mix/fixed-term",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Tenant", key: "tenantName" },
        { label: "Lease End", key: "leaseToDate" },
      ],
      emptyText: "No fixed-term leases found.",
    });
    return;
  }

  if (tileId === "month-to-month") {
    await simpleDrillDown({
      tileId,
      title: "Month-to-Month Leases",
      url: "/api/dashboard/lease-mix/month-to-month",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Tenant", key: "tenantName" },
        { label: "Since", key: "leaseFromDate" },
      ],
      emptyText: "No month-to-month leases found.",
    });
    return;
  }

  if (tileId === "move-ins") {
    await simpleDrillDown({
      tileId,
      title: "Move-Ins",
      url: `/api/dashboard/move-ins/leases?period=${period}`,
      note: "Each row is a Buildium lease whose start date (move-in date) falls within the period selected in the dropdown at the top of the dashboard (This month, Last month, This quarter, Last quarter, This year, or Last year). The tenant name comes from that same lease's current tenants.",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Move-In Date", render: (r) => (r.moveInDate ? formatMonthDayYear(r.moveInDate.slice(0, 10)) : "—") },
        { label: "Tenant", key: "tenantName" },
      ],
      emptyText: "No move-ins in this period.",
    });
    return;
  }

  if (tileId === "evictions-pending") {
    await simpleDrillDown({
      tileId,
      title: "Evictions Pending",
      url: "/api/dashboard/evictions-pending",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Tenant", key: "tenantName" },
      ],
      emptyText: "No evictions pending.",
    });
    return;
  }

  if (tileId === "avg-tenancy") {
    await simpleDrillDown({
      tileId,
      title: "Avg Tenancy",
      url: "/api/dashboard/avg-tenancy/leases",
      note: "Every real tenant Buildium has on file, past and current — not just today's active leases. Each row runs from that tenant's real move-in date to their real move-out date, or to today if they're still living there (never to a current lease's contract end date, since an active tenant can terminate early). If the same tenant lived in the same unit more than once, those stays are combined into one row.",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Tenant", render: (r) => r.tenantName ?? "—" },
        { label: "Moved In", render: (r) => (r.movedIn ? formatMonthDayYear(r.movedIn) : "—") },
        { label: "Moved Out", render: (r) => (r.movedOut ? formatMonthDayYear(r.movedOut) : "Current") },
        { label: "Tenancy (mo)", key: "tenancyMonths" },
      ],
      emptyText: "No tenant history found.",
    });
    return;
  }

  if (tileId === "new-prospects") {
    await simpleDrillDown({
      tileId,
      title: "New Prospects",
      url: `/api/rentengine/prospects?period=${period}`,
      rowsKey: "prospects",
      // Name column ADDED 2026-07-13, matching the vendor's own Prospects
      // drill-down, once RentEngine's real name field got added to our
      // prospect schema for the Leasing Funnel drill-downs below.
      columns: [
        { label: "Name", render: (r) => r.name ?? "—" },
        { label: "Source", key: "source" },
        { label: "Status", key: "status" },
        { label: "Created", key: "createdAt" },
      ],
      emptyText: "No new prospects in this period.",
    });
    return;
  }

  // Leasing Funnel drill-downs — ADDED 2026-07-13, per Jason directly, to
  // match the vendor's own chart (clicking a stage bar opens the real
  // prospects behind that count). One route/handler for all 5 stages —
  // see leasingFunnelStageRows in src/rentengine/client.ts.
  const LEASING_FUNNEL_STAGES = {
    "leasing-funnel-prospects": { stage: "prospects", title: "Prospects" },
    "leasing-funnel-showings-scheduled": { stage: "showingsScheduled", title: "Showings Scheduled" },
    "leasing-funnel-showings-completed": { stage: "showingsCompleted", title: "Showings Completed" },
    "leasing-funnel-applications": { stage: "applications", title: "Applications" },
    "leasing-funnel-move-ins": { stage: "moveIns", title: "Move-ins" },
  };
  if (LEASING_FUNNEL_STAGES[tileId]) {
    const { stage, title } = LEASING_FUNNEL_STAGES[tileId];
    await simpleDrillDown({
      tileId,
      title: `Leasing Funnel — ${title}`,
      url: `/api/rentengine/leasing-funnel/stage?period=${period}&stage=${stage}`,
      rowsKey: "prospects",
      note: "A prospect counts toward every stage they've reached, not just their current status — someone who already applied also counts toward Showings Scheduled and Showings Completed, even if those individual steps aren't separately logged.",
      columns: [
        { label: "Name", render: (r) => r.name ?? "—" },
        { label: "Source", key: "source" },
        { label: "Created", key: "createdAt" },
      ],
      emptyText: "No prospects reached this stage in this period.",
    });
    return;
  }

  if (tileId === "showings-completed") {
    await simpleDrillDown({
      tileId,
      title: "Showings",
      url: `/api/rentengine/showings?period=${period}`,
      rowsKey: "showings",
      columns: [
        { label: "Property", key: "propertyAddress" },
        { label: "Prospect", key: "prospectName" },
        { label: "Status", key: "status" },
        { label: "Planned", key: "plannedDateTime" },
      ],
      emptyText: "No showings in this period.",
    });
    return;
  }

  if (tileId === "total-calls") {
    await simpleDrillDown({
      tileId,
      title: "Total Calls",
      url: `/api/rentengine/calls?period=${period}`,
      rowsKey: "calls",
      columns: [
        { label: "Prospect", key: "prospectName" },
        { label: "Direction", key: "direction" },
        { label: "Status", key: "status" },
        { label: "Duration (s)", key: "durationSeconds" },
      ],
      emptyText: "No calls in this period.",
    });
    return;
  }

  // Address/Status columns ADDED 2026-07-13, per Jason directly, to match
  // the vendor's own drill-down (Address/Status/Health/Days) — previously
  // this only showed a bare RentEngine unit_id, since RentEngine's
  // leasing-performance rows carry no address of their own. See
  // src/api/rentEngineRoutes.ts for where address/status get joined in.
  if (tileId === "avg-dom" || tileId === "median-dom") {
    await simpleDrillDown({
      tileId,
      title: "Days on Market",
      url: `/api/rentengine/units/leasing-performance?period=${period}`,
      rowsKey: "units",
      note: "True days_on_market from RentEngine's per-unit leasing-performance report — resets to 0 whenever a unit is re-listed, so this isn't a running total of every day a unit has ever sat vacant. RentEngine itself only has data going back to 2/11/2026 (when Limehouse's account started there), so it can't reflect anything before that.",
      columns: [
        { label: "Address", render: (r) => r.address ?? `Unit ${r.unitId}` },
        { label: "Status", render: (r) => r.status ?? "—" },
        { label: "Health", render: (r) => r.propertyHealth ?? "—" },
        { label: "Days", render: (r) => (r.daysOnMarket === null ? "—" : r.daysOnMarket) },
      ],
      emptyText: "No unit data available.",
    });
    return;
  }

  // Units on Market — SPLIT OFF 2026-07-13, per Jason directly, from the
  // Days on Market drill-down above (which lists EVERY tracked unit, not
  // just on-market ones) into its own drill-down scoped to real on-market
  // units. Same isUnitOnMarket predicate as the tile's own count (see
  // src/rentengine/client.ts) — status is exactly Available or On Hold,
  // corrected 2026-07-13 after Jason's own manual count caught a real
  // "Incomplete" draft listing being wrongly included (see that file's
  // comment for the full story).
  if (tileId === "units-on-market") {
    await simpleDrillDown({
      tileId,
      title: "Units on Market",
      url: `/api/rentengine/units/on-market?period=${period}`,
      rowsKey: "units",
      note: "Every RentEngine unit whose status is Available or On Hold — not just Available, and not every non-Leased status either (a unit still in RentEngine's Incomplete/draft state, never actually published, doesn't count). Days and Health come from RentEngine's separate per-unit leasing-performance report, so a unit shows \"—\" there if it hasn't appeared in that report yet.",
      columns: [
        { label: "Address", render: (r) => r.address ?? `Unit ${r.unitId}` },
        { label: "Status", render: (r) => r.status ?? "—" },
        { label: "Health", render: (r) => r.propertyHealth ?? "—" },
        { label: "Days", render: (r) => (r.daysOnMarket === null ? "—" : r.daysOnMarket) },
      ],
      emptyText: "No units currently on the market.",
    });
    return;
  }

  // Completion Rate — SPLIT OFF marketing-activity 2026-07-13, per Jason
  // directly, and given a real drill-down (previously had none). Scoped to
  // units actually available for showing (status not Leased/On Hold/
  // Incomplete) — same scoping as summarizeShowingCompletionRate in
  // src/rentengine/client.ts, matching the vendor's own note.
  if (tileId === "completion-rate") {
    await simpleDrillDown({
      tileId,
      title: "Completion Rate",
      url: `/api/rentengine/completion-rate/units?period=${period}`,
      rowsKey: "units",
      note: "Sum of showings completed ÷ sum of showings scheduled, across units whose status makes them available for showing (not Leased, On Hold, or Incomplete) within the selected period. RentEngine does not split showings into accompanied vs. self-guided, so self-showings cannot be excluded.",
      columns: [
        { label: "Address", render: (r) => r.address ?? `Unit ${r.unitId}` },
        { label: "Status", render: (r) => r.status ?? "—" },
        { label: "Scheduled", key: "showingsScheduled" },
        { label: "Completed", key: "showingsCompleted" },
        { label: "Rate", render: (r) => (r.ratePercent === null ? "—" : `${r.ratePercent}%`) },
      ],
      emptyText: "No showings in this period.",
    });
    return;
  }
}

// Generic drill-down helper: opens the loading modal, fetches the given
// URL, opens the real modal with the resolved rows, and falls back to an
// honest error state on failure — same pattern the original 3 hand-written
// drill-downs above already used, just deduplicated so ~15 new tiles don't
// each repeat the same try/catch boilerplate. `rowsKey` is for endpoints
// that wrap rows in an envelope (e.g. {connected, prospects: [...]})
// instead of returning a bare array.
async function simpleDrillDown({ tileId, title, url, note, subtitle, columns, emptyText, rowsKey }) {
  openLoadingModal(title);
  try {
    const response = await apiGet(url);
    const rows = rowsKey ? response[rowsKey] ?? [] : response;
    openDrillDownModal({ title, subtitle: typeof subtitle === "function" ? subtitle(rows) : subtitle, note, columns, rows, emptyText });
  } catch (err) {
    openDrillDownModal({ title, columns: [], rows: [], emptyText: `Couldn't load: ${err.message}` });
  }
}
