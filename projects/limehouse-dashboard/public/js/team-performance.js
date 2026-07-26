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

// "2026-09-30" -> "September 30, 2026" — full month name, matching the
// vendor's real "In progress" banner wording exactly.
function formatLongDate(isoDate) {
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// Full ISO instant (e.g. LeadSimple's created_at/closed_at) -> "Jun 28,
// 2026" — short month name, matching the vendor's real Lease Renewal Rate
// drill-down date format exactly (ADDED 2026-07-19, per Jason directly).
function formatShortMonthDayYear(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// "2026-03-12" -> "03/12/2026" -- ADDED 2026-07-26, per Jason directly, for
// Reconciliation Accuracy's Last Reconciled column (his preferred format,
// not the vendor's own "YYYY-MM-DD"). Plain string slicing, not a Date
// object -- these are date-only values (StatementEndingDate) with no time
// component, so parsing through Date risks an off-by-one from timezone
// conversion.
function formatMMDDYYYY(isoDate) {
  if (!isoDate) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return "—";
  const [, year, month, day] = match;
  return `${month}/${day}/${year}`;
}

// CONFIRMED against a real vendor screenshot (2026-07-26): a plain-English
// reason ("missing TaxPayerId + no insurance on file", "no insurance on
// file", "insurance expired MM/DD/YYYY") in place of a flat Yes/No
// Compliant column. `r.insuranceCurrent` is carried from the backend
// (computed against the same today-reference as `r.compliant`) rather than
// re-derived here, so this never disagrees with the row's own compliant flag.
function vendorComplianceReason(r) {
  if (r.compliant) return "Compliant";
  const reasons = [];
  if (!r.hasTaxPayerId) reasons.push("missing Tax Payer ID");
  if (r.insuranceRequired) {
    if (!r.insuranceExpirationDate) reasons.push("no insurance on file");
    else if (!r.insuranceCurrent) reasons.push(`insurance expired ${formatMMDDYYYY(r.insuranceExpirationDate)}`);
  }
  return reasons.join(" + ");
}

function renderUnlockedView() {
  const content = document.getElementById("page-content");
  const period = tpRolesData.period;
  const [periodYear] = period.split("-");
  const dateRange = { from: tpRolesData.periodStart, to: tpRolesData.periodEnd };
  const dateRangeText = formatDateRange(dateRange).toUpperCase();
  // ISO date (e.g. "2026-07-18"), matching the vendor's exact "AS OF"
  // format — per Jason directly, matching style/format precisely.
  const asOf = new Date().toISOString().slice(0, 10);

  // ADDED 2026-07-19, per Jason directly, against a real vendor
  // screenshot: periodEnd is the quarter's REAL calendar end (e.g.
  // 2026-09-30 for Q3), not clamped to today — so comparing it against
  // today's date is exactly "has this quarter actually finished yet."
  const inProgressBannerHtml =
    tpRolesData.periodEnd > asOf
      ? `<div class="tp-in-progress-banner"><strong>In progress</strong>${formatQuarterLabel(period)} · ${formatDateRange(dateRange)} ends ${formatLongDate(tpRolesData.periodEnd)} — data is still accumulating.</div>`
      : "";

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
    ${inProgressBannerHtml}
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
  // CORRECTED 2026-07-19, per Jason directly, against a real vendor
  // screenshot: Property/Unit/Occupied (yes/no), not a bare unit ID with
  // an Occupied/Vacant label.
  "Portfolio Occupancy Rate": [
    { label: "Property", render: (r) => r.propertyAddress ?? "—" },
    { label: "Unit", render: (r) => r.unitNumber ?? "—" },
    { label: "Occupied", render: (r) => (r.occupied ? "yes" : "no") },
  ],
  "Delinquency Rate": [
    { label: "Property", render: (r) => r.propertyAddress ?? "—" },
    { label: "Unit", render: (r) => r.unitNumber ?? "—" },
    { label: "Balance", render: (r) => formatCurrencyPrecise(r.balance) },
  ],
  "Reconciliation Accuracy": [
    { label: "Bank Account", key: "accountName" },
    { label: "Last Reconciled", render: (r) => (r.lastReconciledDate ? formatMMDDYYYY(r.lastReconciledDate) : "never") },
    { label: "Months Done", render: (r) => `${r.monthsDone} / ${r.monthsExpected}` },
    { label: "Balance", render: (r) => formatCurrency(r.balance) },
    // "on track"/"Not Reconciled" -- per Jason directly 2026-07-26: "on
    // track" confirmed against a real vendor screenshot; "Not Reconciled"
    // (red) is our own wording for the not-on-track case, since the
    // vendor's real wording for that state hasn't been seen yet.
    { label: "Status", render: (r) => (r.onTrack ? "on track" : `<span class="recon-not-reconciled">Not Reconciled</span>`) },
  ],
  "Rent Processing Accuracy": [
    { label: "Property", render: (r) => r.propertyAddress ?? "—" },
    { label: "Unit", render: (r) => r.unitNumber ?? "—" },
    { label: "Reversed Date", render: (r) => formatMMDDYYYY(r.date) },
    { label: "Amount", render: (r) => formatCurrency(r.amount) },
    { label: "Category", key: "category" },
  ],
  "Vendor Compliance": [
    { label: "Vendor", key: "vendorName" },
    { label: "Category", render: (r) => r.category ?? "—" },
    { label: "Tax Payer ID", render: (r) => (r.hasTaxPayerId ? "yes" : "no") },
    { label: "Insurance Expires", render: (r) => formatMMDDYYYY(r.insuranceExpirationDate) },
    { label: "Status", render: (r) => vendorComplianceReason(r) },
  ],
  // CONFIRMED against a real vendor screenshot (2026-07-26): the vendor's
  // own site has "Tax ID Type" (spaced) alongside "TaxPayerId" (one word)
  // in the SAME table -- a real inconsistency, matched exactly as observed
  // rather than forced into one consistent style (same treatment already
  // applied to Lease Renewal Rate's subtitle punctuation elsewhere in this
  // file). Vendor Compliance's own "Tax Payer ID" (spaced) was a separate,
  // explicit request from Jason for THAT drilldown only -- not a rename
  // that carries over here.
  "1099 Compliance": [
    { label: "Vendor", key: "vendorName" },
    { label: "Category", render: (r) => r.category ?? "—" },
    { label: "Tax ID Type", render: (r) => r.taxPayerIdType ?? "—" },
    { label: "TaxPayerId", render: (r) => (r.hasTaxPayerId ? "yes" : "no") },
    { label: "Status", render: (r) => (r.compliant ? "Compliant" : "missing TaxPayerId") },
  ],
  "Days on Market": [
    { label: "Address", render: (r) => r.address ?? "—" },
    { label: "Status", render: (r) => r.status ?? "—" },
    { label: "Health", key: "health" },
    { label: "Days", render: (r) => (r.daysOnMarket === null ? "—" : r.daysOnMarket) },
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
  // CORRECTED 2026-07-19, per Jason directly, against a real vendor
  // screenshot: added the missing Status column (Stage and Status are
  // genuinely different fields — e.g. Stage "Send Lease" has Status
  // "working"), and switched Created/Closed to the vendor's real "Jun 28,
  // 2026" date format instead of a raw ISO slice.
  "Lease Renewal Rate": [
    { label: "Process", key: "processName" },
    { label: "Stage", render: (r) => r.stage ?? "—" },
    { label: "Status", render: (r) => r.status ?? "—" },
    { label: "Created", render: (r) => formatShortMonthDayYear(r.createdAt) },
    { label: "Closed", render: (r) => (r.closedAt ? formatShortMonthDayYear(r.closedAt) : "open") },
    { label: "Renewed", render: (r) => (r.renewed ? "yes" : "no") },
  ],
  "Property Readiness": [
    { label: "Task", render: (r) => r.taskDescription ?? "—" },
    { label: "Process", render: (r) => r.processName ?? "—" },
    { label: "Due", render: (r) => formatShortMonthDayYear(r.dueAt) },
    { label: "Completed", render: (r) => (r.completedAt ? formatShortMonthDayYear(r.completedAt) : "open") },
    { label: "On Time", render: (r) => (r.onTime ? "yes" : "no") },
    { label: "Assignee", render: (r) => r.assignee ?? "—" },
  ],
  "Resident Response Time": [
    { label: "Task", render: (r) => r.taskDescription ?? "—" },
    { label: "Kind", key: "kind" },
    { label: "Start", render: (r) => formatShortMonthDayYear(r.startAt) },
    { label: "Completed", render: (r) => (r.completedAt ? formatShortMonthDayYear(r.completedAt) : "open") },
    { label: "Hours", render: (r) => (r.hours === null ? "—" : r.hours) },
    { label: "Within 24h", render: (r) => (r.within24BusinessHours === null ? "—" : r.within24BusinessHours ? "yes" : "no") },
  ],
};

// KPI name is clickable (has a "›" chevron) — matches the vendor site's own
// "tap any KPI to see the data behind it" pattern. For KPIs with a real,
// live-verified formula, this fetches the actual formula text and the real
// records that produced the number; for anything not wired up yet, it
// shows an honest "not available yet" message rather than fabricating one.
// ADDED 2026-07-19, per Jason directly, against a real vendor screenshot:
// the vendor's own KPI explain modal has a subtitle line above the note
// box ("212 / 230 = 92.2% · target ≥95%") that we were missing entirely.
// The fraction shown is specific to each KPI's own real-world unit (units
// for Occupancy, dollars for Delinquency, processes for Renewal Rate,
// etc.) so this is a per-KPI builder, not one generic formula — starting
// with Occupancy Rate (the only one confirmed against a screenshot so
// far) and extended as more vendor screenshots come in.
const KPI_SUBTITLE_BUILDERS = {
  "Portfolio Occupancy Rate": (result, kpi) => {
    const occupied = result.rows.filter((r) => r.occupied).length;
    const total = result.rows.length;
    return `${occupied} / ${total} = ${formatKpiActual(kpi)} · target ${formatKpiTarget(kpi)}`;
  },
  // Note the vendor's OWN subtitle for this specific KPI uses literal "--"
  // and ">=" (not the "·"/"≥" the Occupancy Rate subtitle uses) — a real,
  // confirmed inconsistency in the vendor's own site between KPIs, matched
  // exactly as observed rather than forced into one universal format.
  "Lease Renewal Rate": (result, kpi) => {
    const renewed = result.rows.filter((r) => r.renewed).length;
    const stillInProgress = result.rows.filter((r) => r.status === "working").length;
    const decided = result.rows.length - stillInProgress;
    return `${formatKpiActual(kpi)} renewed (${renewed}/${decided} decided; ${stillInProgress} still in progress) -- target >=${formatKpiValue(kpi.targetValue, kpi.unit)}`;
  },
  // CONFIRMED against a real vendor screenshot (2026-07-19): cents-level
  // precision, "÷" (not "/"), and "delinquent"/"rent roll" labels. The
  // rows behind this KPI only include the delinquent leases, not every
  // active lease, so the total-rent denominator is backed out from the
  // already-computed percent rather than summed directly.
  "Delinquency Rate": (result, kpi) => {
    const delinquentTotal = result.rows.reduce((sum, r) => sum + r.balance, 0);
    const rentTotal = delinquentTotal / (kpi.actualValue / 100);
    return `${formatCurrencyPrecise(delinquentTotal)} delinquent ÷ ${formatCurrencyPrecise(rentTotal)} rent roll = ${formatKpiActual(kpi)} · target ${formatKpiTarget(kpi)}`;
  },
  // CONFIRMED against a real vendor screenshot (2026-07-19): "Avg 29 ·
  // Median 10", no target shown at all. avg/median come straight from the
  // API response (the same vendor-confirmed Healthy-only calculation the
  // tile itself uses) rather than being re-derived from the drill-down
  // rows, which now intentionally include every tracked unit regardless
  // of health.
  "Days on Market": (result) => {
    const avg = result.avgDaysOnMarket === null ? "—" : `${Math.round(result.avgDaysOnMarket)}d`;
    const median = result.medianDaysOnMarket === null ? "—" : `${Math.round(result.medianDaysOnMarket)}d`;
    return `Avg ${avg} · Median ${median}`;
  },
  // CONFIRMED against a real vendor screenshot (2026-07-26) for the
  // zero-data case only: "No completed months in this period yet". The
  // has-data phrasing below is NOT yet confirmed against a screenshot --
  // built in the same "X/Y -- target Z%" style used elsewhere as a
  // reasonable default, to be corrected if a real screenshot ever shows
  // otherwise.
  "Reconciliation Accuracy": (result, kpi) => {
    const scored = result.rows.filter((r) => !r.excluded);
    const done = scored.reduce((sum, r) => sum + r.monthsDone, 0);
    const expected = scored.reduce((sum, r) => sum + r.monthsExpected, 0);
    if (expected === 0) return "No completed months in this period yet";
    return `${done}/${expected} months completed -- target ${formatKpiValue(kpi.targetValue, kpi.unit)}`;
  },
  // CONFIRMED against a real vendor screenshot (2026-07-26): "0 operational
  // reversals ÷ 203 payments within This month · Jul 1 – Jul 26, 2026 =
  // 100% clean · 4 NSF/bounced excluded · target 100%" -- window text uses
  // OUR real quarter-to-date window (same "describe our actual window"
  // rule as Reconciliation Accuracy above), not the vendor's literal
  // "This month" wording.
  "Rent Processing Accuracy": (result, kpi) => {
    const windowLabel = `${formatQuarterLabel(tpActiveQuarter)} · ${formatDateRange({ from: result.from, to: result.to })}`;
    // "100% clean", not "100.0%" -- confirmed against a real vendor
    // screenshot: whole-number accuracy drops the decimal here (unlike
    // e.g. Property Readiness's confirmed "76.1%", which keeps it).
    const accuracyText = Number.isInteger(kpi.actualValue) ? `${kpi.actualValue}%` : formatKpiActual(kpi);
    return `${result.operationalReversalCount} operational reversals ÷ ${result.paymentCount} payments within ${windowLabel} = ${accuracyText} clean · ${result.nsfReversalCount} NSF/bounced excluded · target ${formatKpiValue(kpi.targetValue, kpi.unit)}`;
  },
  // CONFIRMED against a real vendor screenshot (2026-07-20): "76.1% on
  // time (51/67) -- target 100%" -- note the target has NO ">="/"≥"
  // symbol here, a third distinct subtitle style alongside Occupancy's
  // "·"/"≥" and Renewal Rate's "--"/">=".
  "Property Readiness": (result, kpi) => {
    const onTime = result.rows.filter((r) => r.onTime).length;
    const total = result.rows.length;
    return `${formatKpiActual(kpi)} on time (${onTime}/${total}) -- target ${formatKpiValue(kpi.targetValue, kpi.unit)}`;
  },
  // CONFIRMED against a real vendor screenshot (2026-07-20): "Avg 5.5
  // hours -- 8/8 within 24 biz hours -- target <=24h" -- written out
  // manually (not via formatKpiActual/formatKpiValue) since the vendor
  // shows one decimal place and the word "hours", not the rounded "5h"
  // style used elsewhere for this unit.
  "Resident Response Time": (result, kpi) => {
    const within = result.rows.filter((r) => r.within24BusinessHours).length;
    const total = result.rows.length;
    return `Avg ${kpi.actualValue} hours -- ${within}/${total} within 24 biz hours -- target <=${Math.round(kpi.targetValue)}h`;
  },
  // CONFIRMED against a real vendor screenshot (2026-07-26): "32 compliant
  // ÷ 58 maintenance/trade vendors (Category starts with "Contractor") =
  // 55.2% · target 100%". The real compliant/scoped counts now come from
  // the drill-down rows themselves (post exclude-from-1099 filter, per
  // Jason 2026-07-26), so this stays correct even though it changes the
  // vendor's own screenshot numbers slightly going forward.
  "Vendor Compliance": (result, kpi) => {
    const compliant = result.rows.filter((r) => r.compliant).length;
    const scoped = result.rows.length;
    return `${compliant} compliant ÷ ${scoped} maintenance/trade vendors (Category starts with "Contractor") = ${formatKpiActual(kpi)} · target ${formatKpiValue(kpi.targetValue, kpi.unit)}`;
  },
  // CONFIRMED against a real vendor screenshot (2026-07-26): "46 with
  // TaxPayerId ÷ 58 flagged IncludeIn1099 = 79.3% · target 100% by Jan" --
  // "target 100% by Jan" is the vendor's real DEADLINE-based target, not
  // our own scoring engine's plain ≥100% threshold (a known, documented
  // simplification, see docs/vendor-reference.md) -- written out literally
  // here rather than derived from kpi.targetValue/targetOperator, since our
  // scoring model can't represent "by Jan" at all.
  "1099 Compliance": (result, kpi) => {
    const compliant = result.rows.filter((r) => r.compliant).length;
    const requiring = result.rows.length;
    return `${compliant} with TaxPayerId ÷ ${requiring} flagged IncludeIn1099 = ${formatKpiActual(kpi)} · target 100% by Jan`;
  },
};

// Most KPIs' modal title is just the bare KPI name — a few have their own
// real vendor wording confirmed against a screenshot. A value can be a
// plain string or, for titles that embed the actual date range queried
// (Property Readiness, Resident Response Time), a function of the API
// result.
const KPI_TITLE_OVERRIDES = {
  "Lease Renewal Rate": "Lease Renewal Rate -- LS Process View (12 mo)",
  "Days on Market": "Days on market",
  "Property Readiness": (result) => `Property Readiness -- Move In Tasks (${result.from} – ${result.to})`,
  "Resident Response Time": (result) => `Resident Response Time -- Asst. Property Manager (${result.from} – ${result.to})`,
};

function resolveKpiTitle(kpiName, result) {
  const override = KPI_TITLE_OVERRIDES[kpiName];
  if (typeof override === "function") return override(result);
  return override ?? kpiName;
}

// Most KPIs' modal Note box is just the static formula text from
// KPI_EXPLAIN_FORMULAS. Reconciliation Accuracy's real vendor note is
// dynamic, embedding live-computed numbers -- matched in the vendor's
// own style (2026-07-26 screenshot: "count how many of the 0 completed
// month(s) inside This month · Jul 1 – Jul 26, 2026 have a finished
// reconciliation... 0 excluded... Source: bank_accounts/reconciliations
// tables..."), but describing OUR real scoring window -- per Jason
// directly, "describe our actual window" -- since our window is the
// quarter-to-date, not literally "This month" (those just happen to look
// identical in July; they'd diverge once August starts).
const KPI_NOTE_BUILDERS = {
  "Reconciliation Accuracy": (result) => {
    const expectedMonths = result.rows[0]?.monthsExpected ?? 0;
    const externallyLinkedCount = result.rows.filter((r) => r.externallyLinked).length;
    const zeroBalanceExcludedCount = result.rows.filter((r) => r.excluded && !r.externallyLinked).length;
    const windowLabel = `${formatQuarterLabel(tpActiveQuarter)} · ${formatDateRange({ from: result.from, to: result.to })}`;
    return `Formula: Across active bank accounts, count how many of the ${expectedMonths} completed month(s) inside ${windowLabel} have a finished reconciliation (StatementEndingDate falls in that month, IsFinished=true). Accuracy = done ÷ expected. A partial current month is not yet reconcilable and is not counted. Accounts with ZERO finished reconciliations AND a $0 balance are excluded entirely (nothing to reconcile) — ${zeroBalanceExcludedCount} excluded. Externally-linked (bank-feed) accounts are also excluded entirely, since Buildium's API can't confirm their reconciliation status even though they may genuinely be reconciled — ${externallyLinkedCount} excluded. Source: bank_accounts/reconciliations tables, synced nightly from Buildium /v1/bankaccounts and /v1/bankaccounts/{id}/reconciliations.`;
  },
  // CONFIRMED against a real vendor screenshot (2026-07-26), same "describe
  // our actual window" treatment as Reconciliation Accuracy above.
  "Rent Processing Accuracy": (result) => {
    const windowLabel = `${formatQuarterLabel(tpActiveQuarter)} · ${formatDateRange({ from: result.from, to: result.to })}`;
    const totalReversals = result.operationalReversalCount + result.nsfReversalCount;
    return `Formula: 1 − (operational ReversePayment count ÷ Payment count) across every active lease, within ${windowLabel}. NSF / bounced / charged-back / returned reversals are tenant-driven (not a processing error) and are EXCLUDED from the accuracy %, but still listed here as informational. A reversal is classified NSF if its memo matches NSF/returned/bounced/insufficient/chargeback/declined OR it is within 5 days of an NSF fee on the same lease. Of ${totalReversals} total reversals: ${result.operationalReversalCount} operational (counted), ${result.nsfReversalCount} NSF (excluded). Source: Buildium /v1/leases/{leaseId}/transactions, TransactionTypeEnum = Payment / ReversePayment. ${result.activeLeaseCount} active leases checked.`;
  },
  // Scope/formula wording CONFIRMED against a real vendor screenshot
  // (2026-07-26). The exclude-from-1099 sentence is OUR OWN addition, not
  // in that screenshot -- per Jason directly (2026-07-26), a vendor with
  // Buildium's "Exclude from 1099" box checked (1099-NEC tax filing section
  // on the vendor's own Summary tab) doesn't need a tax ID or insurance at
  // all, so it's now scoped out of this KPI entirely, same as the
  // maintenance-category and active-status scoping already documented here.
  "Vendor Compliance": () => {
    return `Scope: maintenance/trade vendors (Category starts with "Contractor"). Buildium's ?statuses=Active filter is unreliable so vendors are re-filtered on each record's own IsActive flag (inactive vendors dropped). Maintenance/trade vendors are identified by the built-in vendor Category field (names starting with "Contractor", e.g. Contractors - Plumbing/HVAC/Electrical/Roofing); non-service expense categories (Restaurants, Gas Stations, Suppliers, Travel, etc.) are excluded. If no maintenance categories are found, the metric falls back to all active vendors. Vendors with "Exclude from 1099" checked in Buildium (TaxInformation.IncludeIn1099 = false) are excluded entirely -- they don't require a tax ID or insurance on file. Formula: scoped vendors where Tax Payer ID is populated AND (VendorInsurance.ExpirationDate > today OR the vendor's Category is "Contractor - RE Contractor (1099 Work)", which doesn't require insurance for this kind of one-off referral work), ÷ total scoped vendors. Source: Buildium /v1/vendors, reading IsActive, Category.Name, TaxInformation.TaxPayerId, TaxInformation.IncludeIn1099 and VendorInsurance.ExpirationDate.`;
  },
  // CONFIRMED against a real vendor screenshot (2026-07-26).
  "1099 Compliance": () => {
    return `Scope: maintenance/trade vendors (Category starts with "Contractor"). Formula: scoped vendors where IncludeIn1099 is true AND TaxPayerId is populated, ÷ scoped vendors where IncludeIn1099 is true. Source: Buildium /v1/vendors (IsActive + Category.Name), reading TaxInformation.IncludeIn1099 and TaxInformation.TaxPayerId.`;
  },
};

function buildKpiNote(kpiName, result) {
  const builder = KPI_NOTE_BUILDERS[kpiName];
  if (builder) return builder(result);
  return `Formula: ${result.formula}`;
}

// Most subtitle builders assume a real actualValue and would show a
// meaningless "—"-filled string for a "No data" KPI, so buildKpiSubtitle
// skips them by default. Reconciliation Accuracy is the one confirmed
// exception (2026-07-26, real vendor screenshot): the vendor shows a
// subtitle ("No completed months in this period yet") even with zero
// data, and its builder already handles that case explicitly.
const SUBTITLE_BUILDERS_ALLOWED_WITHOUT_DATA = new Set(["Reconciliation Accuracy"]);

function buildKpiSubtitle(kpiName, result) {
  const builder = KPI_SUBTITLE_BUILDERS[kpiName];
  if (!builder) return undefined;
  const role = tpRolesData.roles.find((r) => r.roleDisplayName === tpActiveRole);
  const kpi = role?.kpis.find((k) => k.kpiName === kpiName);
  if (!kpi) return undefined;
  if (!kpi.hasData && !SUBTITLE_BUILDERS_ALLOWED_WITHOUT_DATA.has(kpiName)) return undefined;
  return builder(result, kpi);
}

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
          title: resolveKpiTitle(kpiName, result),
          subtitle: buildKpiSubtitle(kpiName, result),
          note: buildKpiNote(kpiName, result),
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
