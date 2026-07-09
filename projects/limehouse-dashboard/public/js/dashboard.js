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
//     doesn't exist yet. As of 2026-07-04 this only still applies to
//     Completion Rate (no matching concept in RentEngine's API at all,
//     confirmed on Q's second pass too). These will never silently start
//     working — treat them as permanent, not pending.
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
    leaseMixResult,
    delinquencyResult,
    renewals60Result,
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
    daysOnMarketResult,
    moveInsResult,
    avgDaysVacantResult,
    appsSubmittedResult,
  ] = await Promise.allSettled([
    apiGet(`/api/dashboard/period-info?period=${period}`),
    apiGet("/api/dashboard/occupancy"),
    apiGet("/api/dashboard/lease-mix"),
    apiGet("/api/dashboard/delinquency"),
    apiGet("/api/dashboard/renewals?withinDays=60"),
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
    apiGet("/api/rentengine/days-on-market"),
    apiGet(`/api/dashboard/move-ins?period=${period}`),
    apiGet("/api/dashboard/avg-days-vacant"),
    apiGet("/api/dashboard/apps-submitted"),
  ]);

  const periodInfo = unwrap(periodInfoResult);
  const occupancy = unwrap(occupancyResult);
  const leaseMix = unwrap(leaseMixResult);
  const delinquency = unwrap(delinquencyResult);
  const renewals60 = unwrap(renewals60Result);
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
    ${renderOccupancyAndDoors({ occupancy, owners, propertyHealth, doors, avgDaysVacant })}
    ${renderLeasingPipeline({ leaseMix, renewals60, avgTenancy, moveIns, appsSubmitted })}
    ${renderMarketingAndShowings({ leasingFunnel, prospectsBySource, unitsOnMarket, marketingActivity, daysOnMarket })}
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

// ---------------------------------------------------------------------
// OCCUPANCY & DOORS
// ---------------------------------------------------------------------

function renderOccupancyAndDoors({ occupancy, owners, propertyHealth, doors, avgDaysVacant }) {
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
              })
            : couldNotLoadTile({ id: "total-units", label: "Total Units", sourceTags: ["BD"] })
        }
        ${
          occupancy
            ? tileHtml({
                id: "vacant-not-rented",
                label: "Vacant — Not Rented",
                value: formatNumber(occupancy.vacantUnitsByFlag),
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
        ${doorsTile({ doors, id: "doors-lost", label: "Doors Lost / Churn" })}
        ${
          owners
            ? tileHtml({
                id: "owners",
                label: "Owners",
                value: formatNumber(owners.length),
                sub: "Gained this period: not connected yet",
                sourceTags: ["BD"],
                live: true,
              })
            : couldNotLoadTile({ id: "owners", label: "Owners", sourceTags: ["BD"] })
        }
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Occupancy Rate — 12 Months</p>
        ${renderOccupancyTrendChart(occupancy)}
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Property Health</p>
        ${renderPropertyHealthChart(propertyHealth)}
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Doors Added vs Lost</p>
        ${renderDoorsChart(doors)}
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

// Occupancy history (12-month trend) has no backend feed yet — no
// /api/dashboard/occupancy-history route exists, only the current
// point-in-time snapshot. Shows the honest not-connected state rather than
// faking a trend; the chart renderer itself (lineChartHtml in charts.js)
// is ready to go the moment Q ships that endpoint.
function renderOccupancyTrendChart(occupancy) {
  if (!occupancy) {
    return notConnectedBox("Couldn't load", "Current Occupancy tile above may still be live.");
  }
  return notConnectedBox(
    "Not connected yet",
    "12-month occupancy trend history isn't wired up yet — current Occupancy tile above is live."
  );
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

// Doors Added vs Lost — 12-MONTH CHART specifically (distinct from the
// tiles above, which now show real numbers). CORRECTED 2026-07-04: the
// door counts themselves are real now (see doorsTile), but there's no
// month-by-month historical breakdown yet — only cumulative 30/60/90-day
// windows (added) and a 31-day/12-month total (lost estimate). This is a
// genuine "not built yet" gap, not a permanent limitation like the tiles
// used to be — using notConnectedBox (dashed), not notAvailableBox, since
// this one really could get wired up later.
function renderDoorsChart(doors) {
  if (!doors) {
    return notConnectedBox("Couldn't load", "Couldn't reach the doors-tracking endpoint just now.");
  }
  return notConnectedBox(
    "Not connected yet",
    "Month-by-month history isn't wired up yet — the Doors Added and Doors Lost tiles above are live."
  );
}

// ---------------------------------------------------------------------
// LEASING PIPELINE
// ---------------------------------------------------------------------

function renderLeasingPipeline({ leaseMix, renewals60, avgTenancy, moveIns, appsSubmitted }) {
  return `
    <div class="section">
      <p class="section-title">Leasing Pipeline</p>
      <div class="tile-grid">
        ${
          renewals60
            ? tileHtml({
                id: "renewals",
                label: "Renewals",
                value: formatNumber(renewals60.length),
                sub: "Due within 60 days",
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
                label: "Apps Per Move-In",
                value: (appsSubmitted.appsSubmitted / moveIns.moveIns).toFixed(1),
                sourceTags: ["BD"],
                live: true,
              })
            : couldNotLoadTile({ id: "apps-per-move-in", label: "Apps Per Move-In", sourceTags: ["BD"] })
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
        ${notConnectedBox(
          "Not connected yet",
          "12-month renewal history isn't wired up yet — Renewals tile above is live."
        )}
      </div>
    </div>
  `;
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
//     until callActivitySynced is true. completionRate (FIXED 2026-07-05)
//     is showingsCompleted/showingsScheduled*100 from the same reporting
//     rows already fetched here — was wrongly flagged as "not a
//     RentEngine concept" before; it is, it just wasn't being computed.
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
function renderMarketingAndShowings({ leasingFunnel, prospectsBySource, unitsOnMarket, marketingActivity, daysOnMarket }) {
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
                sub: `of ${formatNumber(unitsOnMarket.totalUnitsTracked)} RentEngine-tracked units`,
                sourceTags: ["RE"],
                live: true,
                clickable: true,
              })
            : unitsOnMarket && !unitsOnMarket.connected
            ? tileHtml({ id: "units-on-market", label: "Units on Market", sourceTags: ["RE"], notConnected: true })
            : couldNotLoadTile({ id: "units-on-market", label: "Units on Market", sourceTags: ["RE"] })
        }
        ${
          marketingActivity && marketingActivity.connected && marketingActivity.completionRate !== null
            ? tileHtml({
                id: "completion-rate",
                label: "Completion Rate",
                value: formatPercent(marketingActivity.completionRate),
                sub: `${formatNumber(marketingActivity.showingsCompleted)} of ${formatNumber(
                  marketingActivity.showingsScheduled
                )} showings`,
                sourceTags: ["RE"],
                live: true,
              })
            : marketingActivity && !marketingActivity.connected
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
    sub: `${daysOnMarket.unitsWithData} of ${daysOnMarket.unitsTotal} tracked units`,
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
// (Prospects). No period-over-period % change is shown — the real
// endpoint doesn't return a comparison figure, and RentEngine's account
// history (starts 2026-02-11) is too short to safely derive one without
// risking a misleading comparison against a partial prior period.
function renderLeasingFunnelChart(leasingFunnel) {
  if (!leasingFunnel) {
    return notConnectedBox("Couldn't load", "The leasing funnel numbers didn't come back from RentEngine just now.");
  }
  if (!leasingFunnel.connected) {
    return notConnectedBox("Not connected yet", "Needs RentEngine access for Prospects → Showings → Applications → Move-ins.");
  }
  const funnel = leasingFunnel.funnel;
  const stages = [
    { label: "Prospects", value: funnel.prospects },
    { label: "Showings scheduled", value: funnel.showingsScheduled },
    { label: "Showings completed", value: funnel.showingsCompleted },
    { label: "Applications", value: funnel.applications },
    { label: "Move-ins", value: funnel.moveIns },
  ];
  if (stages.every((s) => s.value === 0)) {
    return `<p class="loading-text">No leasing activity in RentEngine for this period yet.</p>`;
  }
  return horizontalBarListHtml({
    rows: stages.map((s) => ({ label: s.label, value: s.value, displayValue: formatNumber(s.value), color: "#2f6fb0" })),
  });
}

// New Prospects by Source — horizontal bars, one row per source. Handles
// an ARBITRARY/variable list of sources (RentEngine returns however many
// actually have activity for this account — currently 8, up to 12 seen on
// the vendor site) rather than a hardcoded list. Sources come back
// pre-sorted by count from summarizeProspectsBySource on the server; top
// source in brand green, the rest alternating blue/gray per spec.
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
  return horizontalBarListHtml({
    rows: prospectsBySource.sources.map((s, i) => ({
      label: s.source,
      value: s.count,
      displayValue: formatNumber(s.count),
      color: i === 0 ? "#1e5631" : i % 2 === 0 ? "#8b93a1" : "#2f6fb0",
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

  if (tileId === "renewals") {
    await simpleDrillDown({
      tileId,
      title: "Renewals — Next 60 Days",
      url: "/api/dashboard/renewals?withinDays=60",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Lease End", key: "leaseToDate" },
        { label: "Days Left", key: "daysUntilExpiration" },
      ],
      emptyText: "No renewals due in the next 60 days.",
    });
    return;
  }

  // Renewal Rate — REBUILT 2026-07-05: this is now a different population
  // than the "Renewals" (next 60 days) tile above — trailing-12-month
  // renewed-vs-moved-out leases, not upcoming ones. See renewalRateRows in
  // src/kpi/leaseRows.ts.
  if (tileId === "renewal-rate") {
    await simpleDrillDown({
      tileId,
      title: "Renewal Rate — Trailing 12 Months",
      url: "/api/dashboard/renewal-rate/leases",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Outcome", render: (r) => (r.outcome === "renewed" ? "Renewed" : "Moved Out") },
        { label: "From", key: "fromDate" },
        { label: "To", key: "toDate" },
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
      title: "Vacant — Not Rented",
      url: "/api/dashboard/units/vacant",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
      ],
      emptyText: "No vacant units right now.",
    });
    return;
  }

  if (tileId === "avg-days-vacant") {
    await simpleDrillDown({
      tileId,
      title: "Avg Days Vacant",
      url: "/api/dashboard/avg-days-vacant/units",
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Days Vacant", render: (r) => (r.daysVacant === null ? "Unknown (no lease history)" : r.daysVacant) },
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
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
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
      columns: [
        { label: "Property", render: (r) => r.propertyAddress ?? r.propertyId },
        { label: "Unit", key: "unitNumber" },
        { label: "Tenant", key: "tenantName" },
        { label: "Tenancy (mo)", key: "tenancyMonths" },
      ],
      emptyText: "No active leases found.",
    });
    return;
  }

  if (tileId === "new-prospects") {
    await simpleDrillDown({
      tileId,
      title: "New Prospects",
      url: `/api/rentengine/prospects?period=${period}`,
      rowsKey: "prospects",
      columns: [
        { label: "Source", key: "source" },
        { label: "Status", key: "status" },
        { label: "Created", key: "createdAt" },
      ],
      emptyText: "No new prospects in this period.",
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

  if (tileId === "avg-dom" || tileId === "median-dom" || tileId === "units-on-market") {
    await simpleDrillDown({
      tileId,
      title: "Units — Days on Market / Health",
      url: `/api/rentengine/units/leasing-performance?period=${period}`,
      rowsKey: "units",
      columns: [
        { label: "Unit ID", key: "unitId" },
        { label: "Days on Market", render: (r) => (r.daysOnMarket === null ? "—" : r.daysOnMarket) },
        { label: "Property Health", key: "propertyHealth" },
      ],
      emptyText: "No unit data available.",
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
async function simpleDrillDown({ tileId, title, url, note, columns, emptyText, rowsKey }) {
  openLoadingModal(title);
  try {
    const response = await apiGet(url);
    const rows = rowsKey ? response[rowsKey] ?? [] : response;
    openDrillDownModal({ title, note, columns, rows, emptyText });
  } catch (err) {
    openDrillDownModal({ title, columns: [], rows: [], emptyText: `Couldn't load: ${err.message}` });
  }
}
