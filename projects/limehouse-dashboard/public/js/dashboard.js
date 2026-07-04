// Tab 1: Dashboard. Renders every section from the visual spec. Tiles
// backed by a real API route show real numbers; tiles with no backend feed
// yet (Leasing Pipeline flow numbers, Marketing & Showings, Doors Added/Lost
// chart, Owners-gained-this-period, occupancy/renewals 12-month charts) show
// an honest "Not connected yet" state instead of a fake number, matching
// the vendor site's layout so nothing needs rebuilding once those land.
// Financials (Rent By 3rd/10th, Avg Rent/Lease, Avg SD Withheld(%), Rent
// Collection 12-month chart, Delinquency Aging) are wired to real routes as
// of 2026-07-03.

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
    ownersResult,
    rentAndDepositResult,
    delinquencyAgingResult,
    rentCollectionResult,
  ] = await Promise.allSettled([
    apiGet(`/api/dashboard/period-info?period=${period}`),
    apiGet("/api/dashboard/occupancy"),
    apiGet("/api/dashboard/lease-mix"),
    apiGet("/api/dashboard/delinquency"),
    apiGet("/api/dashboard/renewals?withinDays=60"),
    apiGet("/api/dashboard/owners"),
    apiGet("/api/dashboard/financials/rent-and-deposit"),
    apiGet("/api/dashboard/financials/delinquency-aging"),
    apiGet("/api/dashboard/financials/rent-collection"),
  ]);

  const periodInfo = unwrap(periodInfoResult);
  const occupancy = unwrap(occupancyResult);
  const leaseMix = unwrap(leaseMixResult);
  const delinquency = unwrap(delinquencyResult);
  const renewals60 = unwrap(renewals60Result);
  const owners = unwrap(ownersResult);
  const rentAndDeposit = unwrap(rentAndDepositResult);
  const delinquencyAging = unwrap(delinquencyAgingResult);
  const rentCollection = unwrap(rentCollectionResult);

  contextLine.textContent = periodInfo
    ? `${PERIOD_LABELS[period].toUpperCase()} · ${formatDateRange(
        periodInfo.range
      )} · Flow metrics for this period; structural metrics shown as of today`
    : `${PERIOD_LABELS[period].toUpperCase()} · Flow metrics for this period; structural metrics shown as of today`;

  content.innerHTML = `
    ${renderTopOfMind({ delinquency, occupancy, renewals60, leaseMix })}
    ${renderFinancials({ rentAndDeposit, delinquencyAging, rentCollection })}
    ${renderOccupancyAndDoors({ occupancy, owners })}
    ${renderLeasingPipeline({ leaseMix, renewals60 })}
    ${renderMarketingAndShowings()}
  `;

  wireTileClicks();
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

function renderTopOfMind({ delinquency, occupancy, renewals60, leaseMix }) {
  const renewalRatePercent =
    leaseMix && renewals60 && leaseMix.totalActiveLeaseCount > 0
      ? Math.round((renewals60.length / leaseMix.totalActiveLeaseCount) * 1000) / 10
      : null;

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
              })
            : couldNotLoadTile({ id: "occupancy", label: "Occupancy", sourceTags: ["BD"] })
        }
        ${
          leaseMix && renewals60
            ? tileHtml({
                id: "renewal-rate",
                label: "Renewal Rate",
                value: renewalRatePercent === null ? "—" : formatPercent(renewalRatePercent),
                sub: "Leases renewing within 60 days",
                sourceTags: ["BD"],
                live: true,
              })
            : couldNotLoadTile({ id: "renewal-rate", label: "Renewal Rate", sourceTags: ["BD"] })
        }
        ${tileHtml({
          id: "net-doors",
          label: "Net Doors",
          notConnected: true,
          notConnectedReason: "Not connected yet",
          sub: "Needs RentEngine",
          sourceTags: ["RE"],
        })}
      </div>
    </div>
  `;
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
        <p class="chart-card-title">Rent Collection — 12 Months</p>
        ${renderRentCollectionChart(rentCollection)}
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Delinquency Aging</p>
        ${renderDelinquencyAging(delinquencyAging)}
      </div>
    </div>
  `;
}

// Simple bar-per-month list (no chart library — keeps this a plain
// HTML/CSS/vanilla-JS build per the project's simplicity bar). Shows % paid
// by the 3rd and by the 10th for each of the trailing 12 months.
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
  return `
    <div class="breakdown-list">
      ${rentCollection
        .map(
          (m) => `
        <div class="breakdown-row">
          <span>${formatMonthLabel(m.month)}</span>
          <span>By 3rd: <span class="count">${formatPercent(m.paidByThirdPercent)}</span> · By 10th: <span class="count">${formatPercent(m.paidByTenthPercent)}</span></span>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function renderDelinquencyAging(delinquencyAging) {
  if (!delinquencyAging) {
    return notConnectedBox(
      "Couldn't load",
      "The 0-30 / 31-60 / 61-90 / 90+ day breakdown didn't come back from Buildium just now — Total Delinquent above may still be live."
    );
  }
  return `
    <div class="breakdown-list">
      ${delinquencyAging
        .map(
          (bucket) => `
        <div class="breakdown-row">
          <span>${bucket.label} days</span>
          <span><span class="amount">${formatCurrency(bucket.totalBalance)}</span> (${formatNumber(bucket.leaseCount)} leases)</span>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function formatMonthLabel(yyyyMm) {
  const [year, month] = yyyyMm.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, 1));
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------------
// OCCUPANCY & DOORS
// ---------------------------------------------------------------------

function renderOccupancyAndDoors({ occupancy, owners }) {
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
              })
            : couldNotLoadTile({ id: "vacant-not-rented", label: "Vacant — Not Rented", sourceTags: ["BD"] })
        }
        ${tileHtml({ id: "avg-days-vacant", label: "Avg Days Vacant", sourceTags: ["BD"], notConnected: true })}
        ${tileHtml({
          id: "doors-added",
          label: "Doors Added",
          sourceTags: ["BD"],
          notConnected: true,
          notConnectedReason: "Not connected yet",
        })}
        ${tileHtml({ id: "doors-lost", label: "Doors Lost / Churn", sourceTags: ["BD"], notConnected: true })}
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
        ${notConnectedBox("Not connected yet", "Trend history isn't wired up yet — current Occupancy above is live.")}
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Property Health</p>
        ${notConnectedBox(
          "Not connected yet",
          "Healthy / At-risk / Waitlist / On Hold / Off-Market / Commercial breakdown isn't wired up yet."
        )}
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Doors Added vs Lost — 12 Months</p>
        ${notConnectedBox("Not connected yet", "Needs the same doors-added/lost feed as the tiles above.")}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// LEASING PIPELINE
// ---------------------------------------------------------------------

function renderLeasingPipeline({ leaseMix, renewals60 }) {
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
              })
            : couldNotLoadTile({ id: "month-to-month", label: "Month-to-Month", sourceTags: ["BD"] })
        }
        ${tileHtml({ id: "apps-submitted", label: "Apps Submitted", sourceTags: ["LS"], notConnected: true })}
        ${tileHtml({ id: "move-ins", label: "Move-Ins", sourceTags: ["BD"], notConnected: true })}
        ${tileHtml({ id: "apps-per-move-in", label: "Apps Per Move-In", sourceTags: ["LS"], notConnected: true })}
        ${
          leaseMix
            ? tileHtml({
                id: "evictions-pending",
                label: "Evictions Pending",
                value: formatNumber(leaseMix.evictionPendingCount),
                sourceTags: ["BD"],
                live: true,
              })
            : couldNotLoadTile({ id: "evictions-pending", label: "Evictions Pending", sourceTags: ["BD"] })
        }
        ${tileHtml({ id: "avg-tenancy", label: "Avg Tenancy", sourceTags: ["BD"], notConnected: true })}
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Renewals — Trailing 12 Mo</p>
        ${notConnectedBox("Not connected yet", "12-month renewal history isn't wired up yet — Renewals tile above is live.")}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// MARKETING & SHOWINGS
// ---------------------------------------------------------------------

function renderMarketingAndShowings() {
  return `
    <div class="section">
      <p class="section-title">Marketing &amp; Showings</p>
      <div class="tile-grid">
        ${tileHtml({ id: "avg-dom", label: "Avg Days on Market", sourceTags: ["RE"], notConnected: true })}
        ${tileHtml({ id: "median-dom", label: "Median DOM", sourceTags: ["RE"], notConnected: true })}
        ${tileHtml({ id: "units-on-market", label: "Units on Market", sourceTags: ["RE"], notConnected: true })}
        ${tileHtml({ id: "completion-rate", label: "Completion Rate", sourceTags: ["RE"], notConnected: true })}
        ${tileHtml({ id: "new-prospects", label: "New Prospects", sourceTags: ["LS"], notConnected: true })}
        ${tileHtml({ id: "showings-completed", label: "Showings Completed", sourceTags: ["RE"], notConnected: true })}
        ${tileHtml({ id: "total-calls", label: "Total Calls", sourceTags: ["LS"], notConnected: true })}
        ${tileHtml({ id: "outbound-texts", label: "Outbound Texts", sourceTags: ["RE"], notConnected: true })}
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Leasing Funnel — Last 12 Months</p>
        ${notConnectedBox(
          "Not connected yet",
          "Needs RentEngine + LeadSimple access for Prospects → Showings → Applications → Move-ins."
        )}
      </div>
      <div class="chart-card">
        <p class="chart-card-title">New Prospects by Source</p>
        ${notConnectedBox(
          "Not connected yet",
          "Zillow, Realtor.com, RentEngine, Apartments.com, Website Widget, Text AI, Zumper, Other — needs RentEngine + LeadSimple."
        )}
      </div>
    </div>
  `;
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
    openLoadingModal("Renewals — Next 60 Days");
    try {
      const rows = await apiGet("/api/dashboard/renewals?withinDays=60");
      openDrillDownModal({
        title: "Renewals — Next 60 Days",
        columns: [
          { label: "Property", key: "propertyId" },
          { label: "Lease", key: "leaseId" },
          { label: "Lease End", key: "leaseToDate" },
          { label: "Days Left", key: "daysUntilExpiration" },
        ],
        rows,
        emptyText: "No renewals due in the next 60 days.",
      });
    } catch (err) {
      openDrillDownModal({ title: "Renewals", columns: [], rows: [], emptyText: `Couldn't load: ${err.message}` });
    }
  }
}
