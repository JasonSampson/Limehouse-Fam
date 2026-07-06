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
  // /api/dashboard/financials/rent-collection returns { months, cachedAt,
  // stale, lastError } (see dashboardRoutes.ts), not a bare array — unwrap
  // it here once so every renderer below can keep treating rentCollection
  // as a plain array of monthly rows, same as before.
  const rentCollectionResponse = unwrap(rentCollectionResult);
  const rentCollection = rentCollectionResponse ? rentCollectionResponse.months : null;
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

  contextLine.textContent = periodInfo
    ? `${PERIOD_LABELS[period].toUpperCase()} · ${formatDateRange(
        periodInfo.range
      )} · Flow metrics for this period; structural metrics shown as of today`
    : `${PERIOD_LABELS[period].toUpperCase()} · Flow metrics for this period; structural metrics shown as of today`;

  content.innerHTML = `
    ${renderTopOfMind({ delinquency, occupancy, renewalRate, rentCollection, doors })}
    ${renderFinancials({ rentAndDeposit, delinquencyAging, rentCollection })}
    ${renderOccupancyAndDoors({ occupancy, owners, propertyHealth, doors, avgDaysVacant })}
    ${renderLeasingPipeline({ leaseMix, renewals60, avgTenancy, moveIns })}
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
                value: formatCurrency(delinquency.totalOutstandingBalance),
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
          renewalRate
            ? tileHtml({
                id: "renewal-rate",
                label: "Renewal Rate",
                value: renewalRate.renewalRatePercent === null ? "—" : formatPercent(renewalRate.renewalRatePercent),
                sub: `${formatNumber(renewalRate.renewedCount)} renewed · ${formatNumber(renewalRate.movedOutCount)} moved out (12mo)`,
                sourceTags: ["BD"],
                live: true,
                clickable: true,
              })
            : couldNotLoadTile({ id: "renewal-rate", label: "Renewal Rate", sourceTags: ["BD"] })
        }
        ${renderNetDoorsTile(doors)}
      </div>
    </div>
  `;
}

// Net Doors — CORRECTED 2026-07-04, window mismatch FIXED 2026-07-05: this
// used to compare a 90-day "added" count against a 12-month "lost" count —
// two different time spans subtracted into one number isn't meaningful.
// Matches the vendor's "Doors Added vs Lost — 12 Months" metric now: BOTH
// sides use the same trailing-12-month window (doorsAdded365Days is new,
// added to DoorsAddedSummary in src/kpi/churn.ts specifically for this).
// Matches the same window the Net Doors drill-down
// (/api/dashboard/net-doors/properties) already uses.
function renderNetDoorsTile(doors) {
  if (!doors) {
    return couldNotLoadTile({ id: "net-doors", label: "Net Doors", sourceTags: ["BD"] });
  }
  const added = doors.doorsAdded?.doorsAdded365Days;
  const lost = doors.doorsLostEstimated?.doorsLost12Months;
  if (typeof added !== "number" || typeof lost !== "number") {
    return tileHtml({ id: "net-doors", label: "Net Doors", sourceTags: ["BD"], notConnected: true });
  }
  const net = added - lost;
  return tileHtml({
    id: "net-doors",
    label: "Net Doors",
    value: `${net >= 0 ? "+" : ""}${net}`,
    sub: `+${added} added (12mo) · −${lost} lost (12mo, est.)`,
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

function renderFinancials({ rentAndDeposit, delinquencyAging, rentCollection }) {
  // "Rent By 3rd" / "Rent By 10th" tiles show the most recent month's
  // collection rate from the same 12-month series the chart below plots —
  // there's no separate single-value endpoint for just this month, so the
  // latest entry in rentCollection (sorted oldest-to-newest by the API) is
  // this month's figure.
  const latestMonth =
    rentCollection && rentCollection.length > 0 ? rentCollection[rentCollection.length - 1] : null;

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
                sub: `${formatNumber(latestMonth.paidByThirdCount)} of ${formatNumber(latestMonth.totalLeasesDue)} leases`,
                sourceTags: ["BD"],
                live: true,
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
                sub: `${formatNumber(latestMonth.paidByTenthCount)} of ${formatNumber(latestMonth.totalLeasesDue)} leases`,
                sourceTags: ["BD"],
                live: true,
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
        ${renderRentCollectionChart(rentCollection)}
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
    displayValue: `${formatCurrency(bucket.totalBalance)} (${formatNumber(bucket.leaseCount)})`,
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
      value: doors.doorsAdded.doorsAdded30Days,
      sub: `${doors.doorsAdded.doorsAdded60Days} in 60 days · ${doors.doorsAdded.doorsAdded90Days} in 90 days`,
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
      value: doors.doorsLostEstimated.doorsLost31Days,
      sub: `${doors.doorsLostEstimated.doorsLost12Months} in the last 12 months`,
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

function renderLeasingPipeline({ leaseMix, renewals60, avgTenancy, moveIns }) {
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
        ${tileHtml({ id: "apps-submitted", label: "Apps Submitted", sourceTags: ["LS"], notConnected: true })}
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
        ${tileHtml({ id: "apps-per-move-in", label: "Apps Per Move-In", sourceTags: ["LS"], notConnected: true })}
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
          { label: "Property", key: "propertyId" },
          { label: "Lease", key: "leaseId" },
          {
            label: "Balance",
            render: (r) => formatCurrency(r.balance),
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
        { label: "Property", key: "propertyId" },
        { label: "Lease", key: "leaseId" },
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
        { label: "Property", key: "propertyId" },
        { label: "Lease", key: "leaseId" },
        { label: "Outcome", render: (r) => (r.outcome === "renewed" ? "Renewed" : "Moved Out") },
        { label: "Lease End", key: "leaseToDate" },
      ],
      emptyText: "No renewal/move-out activity in the trailing 12 months.",
    });
    return;
  }

  const period = getStoredPeriod();

  if (tileId === "net-doors") {
    await simpleDrillDown({
      tileId,
      title: "Net Doors — Added (12mo) vs Lost (12mo, estimated)",
      url: "/api/dashboard/net-doors/properties",
      columns: [
        { label: "Property", key: "propertyId" },
        { label: "Type", render: (r) => (r.type === "added" ? "Added" : "Lost (estimated)") },
        { label: "Date", key: "date" },
      ],
      emptyText: "No door changes in the tracked windows.",
    });
    return;
  }

  if (tileId === "avg-rent-lease") {
    await simpleDrillDown({
      tileId,
      title: "Avg Rent/Lease",
      url: "/api/dashboard/financials/rent-and-deposit/leases",
      columns: [
        { label: "Property", key: "propertyId" },
        { label: "Unit", key: "unitNumber" },
        { label: "Tenant", key: "tenantName" },
        { label: "Rent", render: (r) => formatCurrency(r.rent) },
      ],
      emptyText: "No active leases with a known rent amount.",
    });
    return;
  }

  if (tileId === "total-units") {
    await simpleDrillDown({
      tileId,
      title: "Total Units",
      url: "/api/dashboard/units",
      columns: [
        { label: "Property", key: "propertyId" },
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
        { label: "Property", key: "propertyId" },
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
        { label: "Property", key: "propertyId" },
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
        { label: "Property", key: "propertyId" },
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
        { label: "Property", key: "propertyId" },
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
        { label: "Property", key: "propertyId" },
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
        { label: "Property", key: "propertyId" },
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
        { label: "Property", key: "propertyId" },
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
async function simpleDrillDown({ tileId, title, url, columns, emptyText, rowsKey }) {
  openLoadingModal(title);
  try {
    const response = await apiGet(url);
    const rows = rowsKey ? response[rowsKey] ?? [] : response;
    openDrillDownModal({ title, columns, rows, emptyText });
  } catch (err) {
    openDrillDownModal({ title, columns: [], rows: [], emptyText: `Couldn't load: ${err.message}` });
  }
}
