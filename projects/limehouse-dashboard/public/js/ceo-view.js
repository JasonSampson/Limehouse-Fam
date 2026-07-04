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

  const [rolesResult, incomeResult] = await Promise.allSettled([
    apiGet(`/api/ceo-view/roles?period=${getStoredPeriod()}`),
    apiGet("/api/ceo-view/income"),
  ]);

  const rolesData = rolesResult.status === "fulfilled" ? rolesResult.value : null;
  const incomeData = incomeResult.status === "fulfilled" ? incomeResult.value : null;

  content.innerHTML = `
    <p class="context-line">CEO VIEW · FINANCIAL PERFORMANCE</p>
    ${renderFinancialCharts(incomeData)}
    ${rolesData ? renderPerformanceByRole(rolesData) : renderRolesCouldNotLoad()}
  `;

  wireRoleKpiClicks();
}

function renderRolesCouldNotLoad() {
  return `
    <div class="section">
      <p class="section-title">Performance by Role · tap any KPI to see the data behind it</p>
      ${notConnectedBox("Couldn't load", "Role scorecards didn't come back just now. Try Sync now, or reload the page.")}
    </div>
  `;
}

// months come back sorted oldest-to-newest (see summarizeMonthlyFinancials
// in src/kpi/financialSummary.ts). "YTD" tiles use the sum of every month
// in the current calendar year present in the response; RPU uses the most
// recent month only, per spec ("RPU — Last Month").
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

  const months = incomeData.months || [];
  const currentYear = new Date().getUTCFullYear();
  const ytdMonths = months.filter((m) => m.month.startsWith(String(currentYear)));
  const grossIncomeYtd = ytdMonths.reduce((sum, m) => sum + m.grossIncome, 0);
  const netIncomeYtd = ytdMonths.reduce((sum, m) => sum + m.netIncome, 0);
  const lastMonth = months.length > 0 ? months[months.length - 1] : null;

  const coverageNote = incomeData.coverage && !incomeData.coverage.fullyCovered
    ? incomeData.coverage.earliestEntryDate
      ? `Data only goes back to ${incomeData.coverage.earliestEntryDate} in Buildium — earlier months aren't available.`
      : "No financial history came back from Buildium for this range yet."
    : null;

  const unverifiedNote = incomeData.unverified
    ? "These numbers come straight from Buildium's ledger but haven't been double-checked against a live account yet — treat as provisional until confirmed."
    : null;

  return `
    <div class="section">
      ${months.length === 0 ? `<p class="loading-text">No financial history available yet.</p>` : ""}
      ${coverageNote ? `<p class="tile-sub" style="margin-bottom:10px;">${coverageNote}</p>` : ""}
      <div class="chart-card">
        <p class="chart-card-title">Gross Income — By Year</p>
        ${renderIncomeMonthList(months, "grossIncome")}
      </div>
      <div class="tile-grid" style="margin-bottom:20px;">
        ${tileHtml({
          id: "gross-income-ytd",
          label: "Gross Income — YTD",
          value: months.length > 0 ? formatCurrency(grossIncomeYtd) : "—",
          sourceTags: ["BD"],
          live: months.length > 0,
        })}
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Net Income — By Year</p>
        ${renderIncomeMonthList(months, "netIncome")}
      </div>
      <div class="tile-grid" style="margin-bottom:20px;">
        ${tileHtml({
          id: "net-income-ytd",
          label: "Net Income — YTD",
          value: months.length > 0 ? formatCurrency(netIncomeYtd) : "—",
          sourceTags: ["BD"],
          live: months.length > 0,
        })}
      </div>
      <div class="chart-card">
        <p class="chart-card-title">Revenue Per Unit — By Year</p>
        ${renderIncomeMonthList(months, "revenuePerUnit")}
      </div>
      <div class="tile-grid" style="margin-bottom:20px;">
        ${tileHtml({
          id: "rpu-last-month",
          label: "RPU — Last Month",
          value: lastMonth && lastMonth.revenuePerUnit !== null ? formatCurrency(lastMonth.revenuePerUnit) : "—",
          sourceTags: ["BD"],
          live: !!lastMonth,
        })}
      </div>
      ${unverifiedNote ? `<p class="tile-sub">${unverifiedNote}</p>` : ""}
    </div>
  `;
}

// Plain month-by-month list (no chart library, per the project's simplicity
// bar). Negative values (Net Income can go negative) are styled distinctly
// per spec via formatCurrency's parenthetical + .negative class.
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

  return `
    <div class="section">
      <p class="section-title">Performance by Role · tap any KPI to see the data behind it</p>
      ${orderedNames.map((name) => renderRoleCard(byName.get(name), name)).join("")}
    </div>
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

  return `
    <div class="role-card">
      <div class="role-card-header">
        <span class="role-card-title">${abbrev} · ${role.roleDisplayName}</span>
        <span class="role-card-stats">
          <span>${onTarget} on tgt</span>
          <span>${withData.length} scored</span>
          <span>${atRisk} at-risk</span>
          <span>${offTrack} off-track</span>
        </span>
      </div>
      ${role.kpis
        .map(
          (k) => `
        <div class="role-kpi-row" data-kpi-name="${k.kpiName}" data-role="${role.roleDisplayName}">
          <span>${k.kpiName}</span>
          <span>${bandPillCeo(k.band, k.hasData)} ${k.hasData ? formatCurrency(k.payoutUsd) : ""}</span>
        </div>
      `
        )
        .join("")}
    </div>
  `;
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
