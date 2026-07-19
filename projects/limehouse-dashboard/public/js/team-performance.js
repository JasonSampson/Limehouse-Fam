// Tab 2: Team Performance. Admin-only — gated server-side (both the page
// load itself and /api/team-performance/roles require an Admin session), so
// this loads directly with no client-side password prompt.

const ROLE_TAB_ORDER = [
  "Portfolio Manager",
  "Portfolio Assistant",
  "Bookkeeper",
  "Leasing Specialist",
  "Marketing Specialist",
  "Administrative Assistant",
];

// ADDED 2026-07-19, per Jason directly, pixel-sampled from the vendor's
// real screenshot (ring gauge stroke measured at rgb(192,57,43) exactly
// matching the trend bar red) — the ring gauge is rendered on a Chart.js
// canvas, not styleable via CSS, so charts.js's shared ringColorForPercent
// (used by CEO View's own ring gauges too, via LH_COLORS) can't be edited
// in place without leaking this page's color fix into CEO View. This is
// the same >=80/>=50 threshold ringColorForPercent already uses, just
// team-performance-local hex values passed explicitly into ringGaugeHtml's
// color override param instead.
function ringColorForTeamPerformance(percent) {
  if (percent >= 80) return "#3b6d11";
  if (percent >= 50) return "#d68910";
  return "#c0392b";
}

let tpRolesData = null;
let tpActiveRole = null;
// ADDED 2026-07-19, per Jason directly, against a real vendor screenshot:
// Team Performance has its OWN Q1-Q4 quarter tabs, separate from the shared
// this_month/this_quarter/etc. dropdown in the header — this page no longer
// reacts to that dropdown at all. null = "not chosen yet, let the server
// pick the real current quarter" (its default, via periodToSnapshotLabel).
let tpActiveQuarter = null;

document.addEventListener("DOMContentLoaded", () => {
  renderHeader("team");
  loadAndRender();
  window.addEventListener("lh:sync-complete", loadAndRender);
});

async function loadAndRender() {
  const content = document.getElementById("page-content");
  content.innerHTML = `<p class="loading-text">Loading…</p>`;

  try {
    const url = tpActiveQuarter
      ? `/api/team-performance/roles?quarter=${tpActiveQuarter}`
      : `/api/team-performance/roles`;
    const roles = await apiGet(url);
    tpRolesData = roles;
    tpActiveQuarter = roles.period; // server always resolves to a real "YYYY-Qn" label
    renderUnlockedView();
  } catch (err) {
    content.innerHTML = errorBanner(`Couldn't load Team Performance data: ${err.message}`);
  }
}

// "2026-Q3" -> "Q3 2026"
function formatQuarterLabel(label) {
  const [year, q] = label.split("-");
  return `${q} ${year}`;
}

// "2026-Q3" -> "Q3 '26" — short-year format, matching the vendor's own
// Quarterly Trend bar labels exactly.
function formatQuarterLabelShort(label) {
  const [year, q] = label.split("-");
  return `${q} '${year.slice(2)}`;
}

// Source-system badge text, matching the vendor's own BD/RE/LS tags.
const SOURCE_BADGE = { buildium: "BD", rent_engine: "RE", lead_simple: "LS" };

// Per-KPI short annotation shown next to the source badge — matches the
// vendor's own "trailing 12 mo" / "as of today" notes. Hardcoded per KPI
// name since these describe each KPI's fixed measurement window, not
// something derivable from the API response.
const KPI_NOTE = {
  "Lease Renewal Rate": "trailing 12 mo",
  "Days on Market": "as of today",
  "Applicant Response Timeliness": "trailing 90d",
};

// Targets are always clean, round configured numbers (95, 70, 21, 3, ...) —
// shown with no decimals, matching the vendor exactly ("≥95%", not
// "≥95.0%"). Actual live-computed values get one decimal for percent
// (e.g. "65.2%"), matching the vendor's own displayed precision.
function formatKpiValue(value, unit, { decimals = false } = {}) {
  if (value === null) return "—";
  if (unit === "percent") return `${decimals ? value.toFixed(1) : Math.round(value)}%`;
  if (unit === "days") return `${Math.round(value)}d`;
  if (unit === "hours") return `${Math.round(value)}h`;
  if (unit === "currency") return formatCurrency(value);
  return String(value);
}

function formatKpiTarget(k) {
  const opSymbol = k.targetOperator === ">=" ? "≥" : "≤";
  return `${opSymbol}${formatKpiValue(k.targetValue, k.unit)}`;
}

function formatKpiActual(k) {
  if (!k.hasData) return "—";
  return formatKpiValue(k.actualValue, k.unit, { decimals: true });
}

// Q1-Q4 of whatever year is currently being viewed — matches the vendor's
// own tab set exactly (always the current year's 4 quarters, no
// cross-year navigation).
function quarterTabsForYear(year) {
  return [1, 2, 3, 4].map((q) => `${year}-Q${q}`);
}

function renderUnlockedView() {
  const content = document.getElementById("page-content");
  const period = tpRolesData.period;
  const [periodYear] = period.split("-");
  const dateRangeText = formatDateRange({ from: tpRolesData.periodStart, to: tpRolesData.periodEnd }).toUpperCase();
  // ISO date (e.g. "2026-07-18"), matching the vendor's exact "AS OF"
  // format — per Jason directly, matching style/format precisely.
  const asOf = new Date().toISOString().slice(0, 10);

  // Match against roleDisplayName — a genuine, code-owned role name
  // (e.g. "Portfolio Manager") from src/db/kpiRepository.ts's
  // ROLE_DISPLAY_NAMES map. The old `displayLabel` field this used to match
  // against was actually a per-KPI label ("Portfolio Occupancy Rate",
  // "Reconciliation Accuracy"), not a role name — so the match against
  // ROLE_TAB_ORDER never succeeded and every role tab silently fell back to
  // the empty state even when the API had fully correct scored data. Fixed
  // 2026-07-03 after this was caught live.
  //
  // The API now seeds every known role (including Marketing Specialist,
  // which has zero KPI definitions) so it always appears in the response
  // with an empty kpis array — no more "missing from the response entirely"
  // case to work around. Any role the API returns that ISN'T in our known
  // order still shows up, appended at the end, so nothing silently vanishes.
  const extraRoles = tpRolesData.roles
    .map((r) => r.roleDisplayName)
    .filter((name) => !ROLE_TAB_ORDER.includes(name));
  const orderedRoles = [...ROLE_TAB_ORDER, ...extraRoles];

  if (!tpActiveRole || !orderedRoles.includes(tpActiveRole)) {
    tpActiveRole = orderedRoles[0] || null;
  }

  content.innerHTML = `
    <div class="role-tabs" id="quarter-tabs">
      ${quarterTabsForYear(periodYear)
        .map((label) => {
          const [, q] = label.split("-");
          return `<button data-quarter="${label}" class="${label === period ? "active" : ""}">${q}</button>`;
        })
        .join("")}
    </div>
    <p class="context-line">${formatQuarterLabel(period)} · ${dateRangeText} · AS OF ${asOf}</p>
    <div class="role-tabs" id="role-tabs">
      ${orderedRoles
        .map((label) => {
          const role = tpRolesData.roles.find((r) => r.roleDisplayName === label);
          const isEmpty = !role || role.kpis.length === 0;
          const classes = [label === tpActiveRole ? "active" : "", isEmpty ? "role-tab-disabled" : ""]
            .filter(Boolean)
            .join(" ");
          return `<button data-role="${label}" class="${classes}">${label}</button>`;
        })
        .join("")}
    </div>
    <div id="role-detail"></div>
  `;

  // Footer text is quarter-specific here, matching the vendor's own footer
  // exactly ("Limehouse PM · Team Performance · Q1 2026 · Jan 1 – Mar 31,
  // 2026") — per Jason directly, unlike the other two tabs' static footer.
  const footerEl = document.getElementById("app-footer");
  if (footerEl) footerEl.textContent = `Limehouse PM · Team Performance · ${formatQuarterLabel(period)} · ${formatDateRange({ from: tpRolesData.periodStart, to: tpRolesData.periodEnd })}`;

  document.querySelectorAll("#quarter-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      tpActiveQuarter = btn.dataset.quarter;
      loadAndRender();
    });
  });

  document.querySelectorAll("#role-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      tpActiveRole = btn.dataset.role;
      renderUnlockedView();
    });
  });

  renderRoleDetail(tpActiveRole);
}

// REBUILT 2026-07-19, per Jason directly, against a real vendor
// screenshot: this used to render a single bar for whatever quarter was
// active, with a hardcoded "trend builds over time" placeholder — the
// vendor's real chart shows multiple real bars, one per quarter that
// actually has scored data, color-coded by that quarter's overall score
// band. A quarter with no snapshot data yet is skipped entirely rather
// than drawn as a fake empty bar (same "honest about missing data"
// pattern already used for individual KPIs on this page).
function trendBarBandClass(percentOfMax) {
  if (percentOfMax >= 99.95) return "quarterly-trend-bar-best";
  if (percentOfMax >= 66.65) return "quarterly-trend-bar-better";
  if (percentOfMax >= 33.25) return "quarterly-trend-bar-good";
  return "quarterly-trend-bar-red";
}

function renderQuarterlyTrend(role) {
  const quartersWithData = (role.trend || []).filter((t) => t.hasData);
  const barsHtml = quartersWithData
    .map((t) => {
      // 106px = the vendor's own real 100% TRACK height, pixel-measured
      // directly from a real screenshot (ADDED 2026-07-19, per Jason
      // directly). The vendor's bar isn't a bare floating bar — it's a
      // "percent full" style: a fixed-height light-gray track representing
      // the full 0-100% range, with a colored fill rising from the bottom
      // to the score's percent. Confirmed by pixel-sampling a visible gray
      // track strip directly above the vendor's real orange/red fills.
      const heightPx = Math.max(8, Math.round((t.percentOfMax / 100) * 106));
      return `
        <div class="quarterly-trend-bar-col">
          <span class="quarterly-trend-bar-amount">${t.percentOfMax.toFixed(0)}%</span>
          <div class="quarterly-trend-bar-track">
            <div class="quarterly-trend-bar ${trendBarBandClass(t.percentOfMax)}" style="height:${heightPx}px;"></div>
          </div>
          <span class="quarterly-trend-bar-label">${formatQuarterLabelShort(t.period)}<br>${formatCurrency(t.totalPayoutUsd)}</span>
        </div>
      `;
    })
    .join("");

  const note = quartersWithData.length
    ? "Each bar is a real scored quarter — height and color reflect that quarter's overall score."
    : "Trend builds as each quarter is captured — the next scored quarter will appear here so you can compare progress over time.";

  return `
    <div class="quarterly-trend-card">
      <p class="section-title" style="margin-bottom:6px;">Quarterly Trend</p>
      <div class="quarterly-trend-bars">${barsHtml}</div>
      <p class="quarterly-trend-note">${note}</p>
    </div>
  `;
}

function renderRoleDetail(roleDisplayName) {
  const detailEl = document.getElementById("role-detail");
  const role = tpRolesData.roles.find((r) => r.roleDisplayName === roleDisplayName);

  // The API now always includes every known role (Marketing Specialist
  // included) with an empty kpis array rather than omitting it, so `!role`
  // shouldn't happen in practice — kept as a defensive fallback rather than
  // assumed, so a future API change that omits a role degrades to the same
  // empty state instead of a blank/broken tab.
  if (!role || role.kpis.length === 0) {
    detailEl.innerHTML = `
      <div class="empty-state">
        <strong>Hired — no measurable KPIs defined yet.</strong>
        Bonus structure to be configured once KPIs are established.
      </div>
    `;
    return;
  }

  const ringCanvasId = `overall-score-ring-${roleDisplayName.replace(/\W+/g, "")}`;
  // Same per-KPI dollar share scoring.ts computes internally — every KPI's
  // own perKpiMax field carries the identical value, so any one of them
  // works as the role-level figure the bonus summary/legend need.
  const perKpiMax = role.kpis[0]?.perKpiMax ?? 0;

  detailEl.innerHTML = `
    <div class="role-detail-top">
      ${ringGaugeHtml({ canvasId: ringCanvasId, percent: role.percentOfMax, size: 84, color: ringColorForTeamPerformance(role.percentOfMax) })}
      <div class="role-detail-top-text">
        <p class="role-name-heading">${roleDisplayName}</p>
        <p class="role-summary-line" style="margin-bottom:0;">${role.kpis.length} accountability KPIs · $${formatNumber(role.maxBonusUsd)} max quarterly bonus</p>
      </div>
    </div>

    ${renderQuarterlyTrend(role)}

    <table class="kpi-table">
      <thead>
        <tr>
          <th>KPI</th>
          <th>Target</th>
          <th>Actual</th>
          <th>Score</th>
          <th>Payout</th>
        </tr>
      </thead>
      <tbody>
        ${role.kpis
          .map(
            (k) => `
          <tr>
            <td>
              <span class="kpi-name-link" data-kpi-name="${k.kpiName}">${k.kpiName} ›</span><br>
              <span class="kpi-badge">${SOURCE_BADGE[k.sourceSystem] ?? k.sourceSystem}</span>${
                KPI_NOTE[k.kpiName] ? `<span class="kpi-note">${KPI_NOTE[k.kpiName]}</span>` : ""
              }<br>
              <span class="kpi-band-dot band-${k.hasData ? k.band : "none"}">●</span><span class="kpi-band-dot band-${k.hasData ? k.band : "none"}">●</span>
            </td>
            <td>${formatKpiTarget(k)}</td>
            <td class="${k.hasData ? `actual-${k.band}` : ""}">${formatKpiActual(k)}</td>
            <td>${bandPill(k.band, k.hasData, k.scorePoints)}</td>
            <td class="${k.hasData ? `actual-${k.band}` : ""}">${k.hasData ? formatCurrency(k.payoutUsd) : "—"}</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>

    <div class="bonus-summary">
      <p class="section-title" style="margin-bottom:6px;">Quarterly Bonus Estimate</p>
      <p class="role-summary-line">Score: ${role.totalScorePoints}/${role.maxScorePoints} (${Math.round(role.percentOfMax)}%) · ${role.originalKpiCount} KPIs × ${formatCurrency(perKpiMax)} max each</p>
      <div class="big-row">
        <span class="big">${formatCurrency(role.totalPayoutUsd)}</span>
        <span style="font-size:14px;color:var(--text-muted);font-weight:600;">of ${formatCurrency(role.maxBonusUsd)} max</span>
      </div>
    </div>

    <div class="legend-row">
      <span class="legend-row-item"><span class="legend-dot band-best"></span>Best (3) = met target → ${formatCurrency(perKpiMax)}</span>
      <span class="legend-row-item"><span class="legend-dot band-better"></span>Better (2) = within 10% → ${formatCurrency((perKpiMax * 2) / 3)}</span>
      <span class="legend-row-item"><span class="legend-dot band-good"></span>Good (1) = within 20% → ${formatCurrency(perKpiMax / 3)}</span>
      <span class="legend-row-item"><span class="legend-dot band-red"></span>Red (0) = missed &gt;20% → $0</span>
    </div>
  `;

  wireKpiNameClicks();
}

// Column definitions per KPI — different KPIs show different underlying
// record shapes (units, leases, vendors, bank accounts, transactions).
const KPI_EXPLAIN_COLUMNS = {
  "Portfolio Occupancy Rate": [
    { label: "Unit", key: "unitId" },
    { label: "Status", render: (r) => (r.occupied ? "Occupied" : "Vacant") },
  ],
  "Delinquency Rate": [
    { label: "Lease", key: "leaseId" },
    { label: "Monthly Rent", render: (r) => formatCurrency(r.monthlyRent) },
    { label: "Delinquent Balance", render: (r) => formatCurrency(r.delinquentBalance) },
  ],
  "Reconciliation Accuracy": [
    { label: "Account", key: "accountName" },
    { label: "Balance", render: (r) => formatCurrency(r.balance) },
    { label: "Status", key: "status" },
  ],
  "Rent Processing Accuracy": [
    { label: "Lease", key: "leaseId" },
    { label: "Date", key: "date" },
    { label: "Amount", render: (r) => formatCurrency(r.amount) },
    { label: "Classification", key: "classification" },
    { label: "Memo", render: (r) => r.memo ?? "—" },
  ],
  "Vendor Compliance": [
    { label: "Vendor", key: "vendorName" },
    { label: "Category", render: (r) => r.category ?? "—" },
    { label: "Tax ID on File", render: (r) => (r.hasTaxPayerId ? "Yes" : "No") },
    { label: "Insurance Expires", render: (r) => (r.insuranceExpirationDate ? r.insuranceExpirationDate.slice(0, 10) : "—") },
    { label: "Compliant", render: (r) => (r.compliant ? "Yes" : "No") },
  ],
  "1099 Compliance": [
    { label: "Vendor", key: "vendorName" },
    { label: "Category", render: (r) => r.category ?? "—" },
    { label: "Tax ID on File", render: (r) => (r.hasTaxPayerId ? "Yes" : "No") },
    { label: "Compliant", render: (r) => (r.compliant ? "Yes" : "No") },
  ],
  "Days on Market": [
    { label: "Unit", key: "unitId" },
    { label: "Days on Market", render: (r) => (r.daysOnMarket === null ? "—" : r.daysOnMarket) },
  ],
  "Application Processing Time": [
    { label: "Application", key: "applicationName" },
    { label: "Created", render: (r) => r.createdAt.slice(0, 10) },
    { label: "Closed", render: (r) => r.closedAt.slice(0, 10) },
    { label: "Hours", key: "hours" },
  ],
  "Applicant Response Timeliness": [
    { label: "Application", key: "applicationName" },
    { label: "First Task", render: (r) => r.firstTaskDescription ?? "No completed task yet" },
    { label: "Hours to Complete", render: (r) => (r.hoursToComplete === null ? "—" : r.hoursToComplete) },
    { label: "Within 24h", render: (r) => (r.within24h === null ? "—" : r.within24h ? "yes" : "no") },
    { label: "Assignee", render: (r) => r.assignee ?? "—" },
  ],
  "Showing Completion Rate": [
    { label: "Unit", key: "unitId" },
    { label: "Showings Scheduled", key: "showingsScheduled" },
    { label: "Showings Completed", key: "showingsCompleted" },
  ],
  "Lease Renewal Rate": [
    { label: "Process", key: "processName" },
    { label: "Stage", render: (r) => r.stage ?? "—" },
    { label: "Created", render: (r) => r.createdAt.slice(0, 10) },
    { label: "Closed", render: (r) => (r.closedAt ? r.closedAt.slice(0, 10) : "open") },
    { label: "Renewed", render: (r) => (r.renewed ? "yes" : "no") },
  ],
};

// KPI name is clickable (has a "›" chevron) — matches the vendor site's own
// "tap any KPI to see the data behind it" pattern. For KPIs with a real,
// live-verified formula, this fetches the actual formula text and the real
// records that produced the number; for anything not wired up yet, it
// shows an honest "not available yet" message rather than fabricating one.
function wireKpiNameClicks() {
  document.querySelectorAll(".kpi-name-link").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      const kpiName = el.dataset.kpiName;
      openLoadingModal(kpiName);
      try {
        const result = await apiGet(
          `/api/team-performance/kpi-explain/${encodeURIComponent(kpiName)}?quarter=${tpActiveQuarter}`
        );
        const columns = KPI_EXPLAIN_COLUMNS[kpiName] ?? [];
        openDrillDownModal({
          title: kpiName,
          formula: result.formula,
          columns,
          rows: result.rows,
          emptyText: "No records behind this KPI for the selected period.",
        });
      } catch (err) {
        openDrillDownModal({
          title: kpiName,
          columns: [],
          rows: [],
          emptyText:
            err.status === 404
              ? "The data behind this KPI isn't wired up yet — only the score band and payout are live right now."
              : `Couldn't load the data behind this KPI: ${err.message}`,
        });
      }
    });
  });
}

// "Better·2" — band name + raw point value (0-3), matching the vendor's
// own pill text exactly, per Jason directly. scorePoints is passed in
// separately (not read off a lookup table) since it's already the real
// value scoring.ts computed for this exact KPI.
function bandPill(band, hasData, scorePoints) {
  if (!hasData || !band) return `<span class="band-pill band-none">No data</span>`;
  const labels = { best: "Best", better: "Better", good: "Good", red: "Red" };
  return `<span class="band-pill band-${band}">${labels[band]}·${scorePoints}</span>`;
}
