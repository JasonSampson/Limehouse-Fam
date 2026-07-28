// Tab 3: CEO View. No separate password (uses the main session). Two parts,
// fetched independently via Promise.allSettled so a failure in one doesn't
// blank the other:
// 1) Gross Income / Net Income / Revenue Per Unit — charts + tiles, from
//    /api/ceo-view/income. The route exists and returns a well-formed
//    shape, but the underlying Buildium GL numbers are flagged `unverified:
//    true` by the API itself (no live Buildium credentials yet for this
//    project) — shown with a small note rather than hidden, since the
//    numbers ARE real once a live key exists and the shape won't change.
// 2) Performance by Role — PM / APM / BC rollup cards fed by the same
//    scoring engine as Team Performance, via /api/ceo-view/roles.

const CEO_ROLE_ORDER = ["Portfolio Manager", "Assistant Property Manager", "Bookkeeping Coordinator"];
const CEO_ROLE_ABBREV = {
  "Portfolio Manager": "PM",
  "Assistant Property Manager": "APM",
  "Bookkeeping Coordinator": "BC",
};

document.addEventListener("DOMContentLoaded", () => {
  renderHeader("ceo");
  loadCeoView();
  window.addEventListener("lh:period-changed", loadCeoView);
  window.addEventListener("lh:sync-complete", loadCeoView);
});

async function loadCeoView() {
  const content = document.getElementById("page-content");
  content.innerHTML = `<p class="loading-text">Loading CEO View…</p>`;

  const [rolesResult, incomeResult, balancesResult] = await Promise.allSettled([
    apiGet(`/api/ceo-view/roles?period=${getStoredPeriod()}`),
    apiGet("/api/ceo-view/income"),
    apiGet("/api/ceo-view/account-balances"),
  ]);

  const rolesData = rolesResult.status === "fulfilled" ? rolesResult.value : null;
  const incomeData = incomeResult.status === "fulfilled" ? incomeResult.value : null;
  const balancesData = balancesResult.status === "fulfilled" ? balancesResult.value : null;

  content.innerHTML = `
    <p class="context-line">CEO VIEW · FINANCIAL PERFORMANCE</p>
    ${renderTopTileRow(balancesData, incomeData)}
    ${renderFinancialCharts(incomeData)}
    ${rolesData ? renderPerformanceByRole(rolesData) : renderRolesCouldNotLoad()}
  `;

  wireRoleKpiClicks();
}

// Pure computation shared by the top tile row and the by-year charts below
// it — kept in one place so the YTD/last-month numbers can never drift
// between the two.
function computeFinancialTileValues(incomeData) {
  const months = (incomeData && incomeData.months) || [];
  const currentYear = new Date().getUTCFullYear();
  const ytdMonths = months.filter((m) => m.month.startsWith(String(currentYear)));
  const grossIncomeYtd = ytdMonths.reduce((sum, m) => sum + m.grossIncome, 0);
  const netIncomeYtd = ytdMonths.reduce((sum, m) => sum + m.netIncome, 0);
  // FIXED 2026-07-06: "RPU — Last Month" means the last FULLY COMPLETED
  // calendar month, same as every other "last month" tile in this app —
  // not months[months.length-1], which is always the current,
  // still-in-progress month.
  const currentMonthKey = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const completedMonths = months.filter((m) => m.month < currentMonthKey);
  const lastMonth = completedMonths.length > 0 ? completedMonths[completedMonths.length - 1] : null;

  const coverageNote = incomeData && incomeData.coverage && !incomeData.coverage.fullyCovered
    ? incomeData.coverage.earliestEntryDate
      ? `Data only goes back to ${incomeData.coverage.earliestEntryDate} in Buildium — earlier months aren't available.`
      : "No financial history came back from Buildium for this range yet."
    : null;

  const unverifiedNote = incomeData && incomeData.unverified
    ? "These numbers come straight from Buildium's ledger but haven't been double-checked against a live account yet — treat as provisional until confirmed."
    : null;

  return { months, currentYear, grossIncomeYtd, netIncomeYtd, lastMonth, coverageNote, unverifiedNote };
}

// Top-row summary tiles — REORGANIZED 2026-07-26, per Jason directly:
// Account Balances (new), then Gross Income — YTD, Net Income — YTD, RPU —
// Last Month, left to right in that order. Previously each of the 3
// income metrics had its own tile stacked directly under its own chart;
// they're pulled up here into one shared row instead, and the charts below
// no longer render a tile of their own.
//
// UPDATED 2026-07-26, per Jason directly: Account Balances lists every
// account + balance directly in the tile (no click-through) — built by
// hand rather than via tileHtml() since it's a list, not one headline
// number. align-items:start on this row keeps it from stretching the 3
// simple number tiles beside it to match its taller height (CSS grid's
// default is to stretch every cell in a row to the tallest one).
function renderTopTileRow(balancesData, incomeData) {
  const { months, grossIncomeYtd, netIncomeYtd, lastMonth } = computeFinancialTileValues(incomeData);
  return `
    <div class="tile-grid" style="margin-bottom:20px; align-items:start;">
      ${renderAccountBalancesTile(balancesData)}
      ${tileHtml({
        id: "gross-income-ytd",
        label: "Gross Income — YTD",
        value: months.length > 0 ? formatCurrency(grossIncomeYtd) : "—",
        sourceTags: ["BD"],
        live: months.length > 0,
      })}
      ${tileHtml({
        id: "net-income-ytd",
        label: "Net Income — YTD",
        value: months.length > 0 ? formatCurrency(netIncomeYtd) : "—",
        sourceTags: ["BD"],
        live: months.length > 0,
      })}
      ${tileHtml({
        id: "rpu-last-month",
        label: "RPU — Last Month",
        value: lastMonth && lastMonth.revenuePerUnit !== null ? formatCurrency(lastMonth.revenuePerUnit) : "—",
        sourceTags: ["BD"],
        live: !!lastMonth,
      })}
    </div>
  `;
}

// Shortened display names — ADDED 2026-07-26, per Jason directly (exact
// mapping he gave). Falls back to the real Buildium account name for
// anything not on this list, rather than guessing a shortened form for an
// account we haven't been told how to abbreviate.
const ACCOUNT_SHORT_NAMES = {
  "American Express Credit Card": "American Express",
  "Capital One Credit Card": "Capital One",
  "Enterprise- Escrow/Trust": "Escrow/Trust",
  "Enterprise- LHPM": "LHPM",
  "Enterprise- Operating": "Operating",
};

function accountBreakdownRow(a) {
  const label = ACCOUNT_SHORT_NAMES[a.accountName] ?? a.accountName;
  return `<div class="breakdown-row"><span>${label}</span><span>${formatCurrency(a.balance)}</span></div>`;
}

function renderAccountBalancesTile(balancesData) {
  if (!balancesData || balancesData.accounts.length === 0) {
    const message = balancesData ? "No active accounts" : "—";
    return `
      <div class="tile" style="grid-column: span 2; min-width:320px;">
        <div class="tile-top">
          <span class="tile-label">Account Balances</span>
          ${badgeHtml(["BD"], !!balancesData)}
        </div>
        <p class="tile-value not-connected">${message}</p>
      </div>
    `;
  }

  // Two columns — per Jason directly: the 3 "Enterprise-" accounts on the
  // left, the 2 credit card accounts on the right.
  const enterpriseAccounts = balancesData.accounts.filter((a) => a.accountName.startsWith("Enterprise"));
  const otherAccounts = balancesData.accounts.filter((a) => !a.accountName.startsWith("Enterprise"));

  return `
    <div class="tile" style="grid-column: span 2; min-width:320px;">
      <div class="tile-top">
        <span class="tile-label">Account Balances</span>
        ${badgeHtml(["BD"], true)}
      </div>
      <div style="display:flex; gap:20px; margin-top:8px;">
        <div class="breakdown-list account-balances-list" style="flex:1;">${enterpriseAccounts.map(accountBreakdownRow).join("")}</div>
        <div class="breakdown-list account-balances-list" style="flex:1;">${otherAccounts.map(accountBreakdownRow).join("")}</div>
      </div>
    </div>
  `;
}

function renderRolesCouldNotLoad() {
  return `
    <div class="section">
      <p class="section-title">Performance by Role · tap any KPI to see the data behind it</p>
      ${notConnectedBox("Couldn't load", "Role scorecards didn't come back just now. Try Sync Now, or reload the page.")}
    </div>
  `;
}

// months come back sorted oldest-to-newest (see summarizeMonthlyFinancials
// in src/kpi/financialSummary.ts). REORGANIZED 2026-07-26: the YTD/last-
// month tiles that used to sit directly under each chart moved up into
// the shared top tile row (renderTopTileRow) — this function now renders
// just the 3 "By Year" charts themselves, in the same order.
function renderFinancialCharts(incomeData) {
  if (!incomeData) {
    return `
      <div class="section">
        ${["Gross Income", "Net Income", "Revenue Per Unit"]
          .map(
            (title) => `
          <div class="chart-card">
            <p class="chart-card-title">${title} — By Year</p>
            ${notConnectedBox("Couldn't load", "The monthly financial numbers didn't come back from Buildium just now.")}
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }

  const { months, currentYear, coverageNote, unverifiedNote } = computeFinancialTileValues(incomeData);

  return `
    <div class="section">
      ${months.length === 0 ? `<p class="loading-text">No financial history available yet.</p>` : ""}
      ${coverageNote ? `<p class="tile-sub" style="margin-bottom:10px;">${coverageNote}</p>` : ""}
      <div class="chart-card">
        <p class="chart-card-title">Gross Income — By Year</p>
        ${renderYearOverYearChart(months, "grossIncome", currentYear, "gross-income-chart", formatCurrencyShort)}
      </div>
      <div class="chart-card" style="margin-top:20px;">
        <p class="chart-card-title">Net Income — By Year</p>
        ${renderYearOverYearChart(months, "netIncome", currentYear, "net-income-chart", formatCurrencyShort)}
      </div>
      <div class="chart-card" style="margin-top:20px;">
        <p class="chart-card-title">Revenue Per Unit — By Year</p>
        ${renderYearOverYearChart(months, "revenuePerUnit", currentYear, "rpu-chart", formatCurrencyShort)}
      </div>
      ${unverifiedNote ? `<p class="tile-sub" style="margin-top:12px;">${unverifiedNote}</p>` : ""}
    </div>
  `;
}

function formatCurrencyShort(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return `${n < 0 ? "-" : ""}$${Math.round(abs / 1000)}k`;
  return formatCurrency(n);
}

// One line chart per metric with MULTIPLE overlapping lines — one per
// year (2018 through today) — all plotted against the same Jan-Dec x-axis
// so seasonal patterns compare year over year, per the visual-parity
// spec. Older years render as light gray/olive; the current year is
// highlighted in blue. Falls back to the flat monthly list if there
// aren't at least 2 distinct years of data yet (a single-year line chart
// wouldn't show the year-over-year comparison this chart type exists for).
function renderYearOverYearChart(months, field, currentYear, canvasId, yFormat) {
  if (months.length === 0) {
    return `<p class="loading-text">No data for this range yet.</p>`;
  }

  const seriesByYear = {};
  months.forEach((m) => {
    const [year, monthNum] = m.month.split("-").map(Number);
    if (!seriesByYear[year]) seriesByYear[year] = new Array(12).fill(null);
    const value = m[field];
    seriesByYear[year][monthNum - 1] = value === null || value === undefined ? null : value;
  });

  const years = Object.keys(seriesByYear);
  if (years.length < 2) {
    // Not enough distinct years yet for a meaningful year-over-year
    // comparison — show the plain month list instead.
    return renderIncomeMonthList(months, field);
  }

  return yearOverYearLineChartHtml({ canvasId, seriesByYear, currentYear, yFormat });
}

// Plain month-by-month list — fallback for when there's under 2 years of
// history (not enough for the year-over-year line chart), or as a simple
// readable alternative. Negative values (Net Income can go negative) are
// styled distinctly per spec via formatCurrency's parenthetical +
// .negative class.
function renderIncomeMonthList(months, field) {
  if (months.length === 0) {
    return `<p class="loading-text">No data for this range yet.</p>`;
  }
  return `
    <div class="breakdown-list">
      ${months
        .map((m) => {
          const value = m[field];
          const isNegative = typeof value === "number" && value < 0;
          return `
        <div class="breakdown-row">
          <span>${formatMonthLabel(m.month)}</span>
          <span class="${isNegative ? "negative" : ""}">${value === null ? "—" : formatCurrency(value)}</span>
        </div>
      `;
        })
        .join("")}
    </div>
  `;
}

function formatMonthLabel(yyyyMm) {
  const [year, month] = yyyyMm.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, 1));
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function renderPerformanceByRole(rolesData) {
  // Match against roleDisplayName (genuine role name, e.g. "Portfolio
  // Manager") — same fix as Team Performance's team-performance.js. The old
  // `displayLabel` field this matched against was actually a per-KPI label,
  // not a role name, so this lookup never succeeded. The API now always
  // includes every known role (empty kpis array for ones with none
  // configured, e.g. Marketing Specialist under team_performance) rather
  // than omitting it, so renderRoleCard's `!role` branch below is a
  // defensive fallback, not a required workaround.
  const byName = new Map(rolesData.roles.map((r) => [r.roleDisplayName, r]));
  const extraRoles = rolesData.roles.map((r) => r.roleDisplayName).filter((name) => !CEO_ROLE_ORDER.includes(name));
  const orderedNames = [...CEO_ROLE_ORDER, ...extraRoles];
  const orderedRoles = orderedNames.map((name) => ({ role: byName.get(name), name }));

  return `
    <div class="section">
      <p class="section-title">Performance by Role · tap any KPI to see the data behind it</p>
      <div class="role-pill-row">
        ${orderedRoles.map(({ role, name }) => renderRolePill(role, name)).join("")}
      </div>
      ${orderedRoles.map(({ role, name }) => renderRoleCard(role, name)).join("")}
    </div>
  `;
}

// Status is derived from each role's KPI bands: off-track if any KPI is
// "red", at-risk if any is "good"/"better" (but none red), on-track
// otherwise. Roles with no scored KPIs yet show as on-track (neutral)
// rather than implying a problem that isn't there.
function roleStatus(role) {
  if (!role || role.kpis.length === 0) return "on-track";
  const withData = role.kpis.filter((k) => k.hasData);
  if (withData.some((k) => k.band === "red")) return "off-track";
  if (withData.some((k) => k.band === "good" || k.band === "better")) return "at-risk";
  return "on-track";
}

function renderRolePill(role, fallbackName) {
  const roleDisplayName = role ? role.roleDisplayName : fallbackName;
  const abbrev = CEO_ROLE_ABBREV[roleDisplayName] || roleDisplayName;
  const status = roleStatus(role);
  const onTarget = role ? role.kpis.filter((k) => k.hasData && k.band === "best").length : 0;
  const scored = role ? role.kpis.filter((k) => k.hasData).length : 0;
  return `
    <span class="role-pill">
      <span class="status-dot status-${status}"></span>
      ${abbrev} · ${roleDisplayName} · ${onTarget}/${scored || "—"} on tgt
    </span>
  `;
}

function renderRoleCard(role, fallbackName) {
  const roleDisplayName = role ? role.roleDisplayName : fallbackName;
  const abbrev = CEO_ROLE_ABBREV[roleDisplayName] || roleDisplayName;

  // Role absent from the API response gets the same empty-card treatment
  // as a role present with an empty kpis array (defensive fallback — see
  // comment in renderPerformanceByRole above).
  if (!role || role.kpis.length === 0) {
    return `
      <div class="role-card">
        <div class="role-card-header">
          <span class="role-card-title">${abbrev} · ${roleDisplayName}</span>
        </div>
        <p class="tile-sub" style="margin-top:8px;">No measurable KPIs defined yet for this role.</p>
      </div>
    `;
  }

  const withData = role.kpis.filter((k) => k.hasData);
  const onTarget = withData.filter((k) => k.band === "best").length;
  const atRisk = withData.filter((k) => k.band === "good" || k.band === "better").length;
  const offTrack = withData.filter((k) => k.band === "red").length;
  const status = roleStatus(role);
  const statusLabel = { "on-track": "On track", "at-risk": "At risk", "off-track": "Off track" }[status];
  const fractionCanvasId = `fraction-ring-${abbrev.replace(/\W+/g, "")}`;
  const fractionPercent = withData.length > 0 ? Math.round((onTarget / withData.length) * 100) : 0;

  return `
    <div class="role-card">
      <div class="role-card-header">
        <span class="role-card-title">${abbrev} · ${role.roleDisplayName}</span>
        <span class="status-pill status-${status}">${statusLabel}</span>
      </div>
      <div class="role-card-body">
        ${ringGaugeHtml({ canvasId: fractionCanvasId, percent: fractionPercent, size: 56, label: `${onTarget}/${withData.length}` })}
        <div class="role-card-kpi-list">
          <span class="role-card-stats" style="margin-bottom:6px;display:flex;">
            <span>${onTarget} on tgt</span>
            <span>${withData.length} scored</span>
            <span>${atRisk} at-risk</span>
            <span>${offTrack} off-track</span>
          </span>
          ${role.kpis
            .map(
              (k) => `
            <div class="role-kpi-row" data-kpi-name="${k.kpiName}" data-role="${role.roleDisplayName}">
              <span class="role-kpi-row-left">
                <span class="status-dot status-${kpiStatusDot(k)}"></span>
                <span class="source-tag">BD</span>
                ${k.kpiName}
              </span>
              <span class="role-kpi-row-right">
                ${bandPillCeo(k.band, k.hasData)}
                <span class="${k.hasData ? `actual-${k.band}` : ""}">${k.hasData ? formatCurrency(k.payoutUsd) : ""}</span>
              </span>
            </div>
          `
            )
            .join("")}
        </div>
      </div>
    </div>
  `;
}

function kpiStatusDot(k) {
  if (!k.hasData || !k.band) return "on-track";
  if (k.band === "red") return "off-track";
  if (k.band === "good" || k.band === "better") return "at-risk";
  return "on-track";
}

function bandPillCeo(band, hasData) {
  if (!hasData || !band) return `<span class="band-pill band-none">No data</span>`;
  const labels = { best: "Best", better: "Better", good: "Good", red: "Red" };
  return `<span class="band-pill band-${band}">${labels[band]}</span>`;
}

function wireRoleKpiClicks() {
  document.querySelectorAll(".role-kpi-row").forEach((el) => {
    el.addEventListener("click", () => {
      openDrillDownModal({
        title: el.dataset.kpiName,
        columns: [],
        rows: [],
        emptyText:
          "The data behind this KPI (Target vs Actual detail) isn't wired up yet — only the score band and payout are live right now.",
      });
    });
  });
}
