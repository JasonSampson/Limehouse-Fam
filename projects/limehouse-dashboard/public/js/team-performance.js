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

let tpRolesData = null;
let tpActiveRole = null;

document.addEventListener("DOMContentLoaded", () => {
  renderHeader("team");
  loadAndRender();
  window.addEventListener("lh:period-changed", loadAndRender);
  window.addEventListener("lh:sync-complete", loadAndRender);
});

async function loadAndRender() {
  const content = document.getElementById("page-content");
  content.innerHTML = `<p class="loading-text">Loading…</p>`;

  try {
    const roles = await apiGet(`/api/team-performance/roles?period=${getStoredPeriod()}`);
    tpRolesData = roles;
    renderUnlockedView();
  } catch (err) {
    content.innerHTML = errorBanner(`Couldn't load Team Performance data: ${err.message}`);
  }
}

function renderUnlockedView() {
  const content = document.getElementById("page-content");
  const period = tpRolesData.period;
  const asOf = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

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
    <p class="context-line">${period} · AS OF ${asOf.toUpperCase()}</p>
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

  document.querySelectorAll("#role-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      tpActiveRole = btn.dataset.role;
      renderUnlockedView();
    });
  });

  renderRoleDetail(tpActiveRole);
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

  // percentOfMax already comes back as a percentage (e.g. 25, not 0.25) —
  // src/kpi/scoring.ts's roundPercent() multiplies by 100 server-side.
  const pctText = `${role.percentOfMax.toFixed(1)}%`;
  const ringCanvasId = `overall-score-ring-${roleDisplayName.replace(/\W+/g, "")}`;

  detailEl.innerHTML = `
    <div class="role-detail-top">
      ${ringGaugeHtml({ canvasId: ringCanvasId, percent: role.percentOfMax, size: 84 })}
      <div class="role-detail-top-text">
        <p class="role-summary-line">${role.kpis.length} accountability KPIs · $${formatNumber(role.maxBonusUsd)} max quarterly bonus</p>
        <p class="role-summary-line" style="margin-bottom:0;">Overall score: ${pctText} of max bonus</p>
      </div>
    </div>

    <table class="kpi-table">
      <thead>
        <tr>
          <th>KPI</th>
          <th>Score</th>
          <th>Payout</th>
        </tr>
      </thead>
      <tbody>
        ${role.kpis
          .map(
            (k) => `
          <tr>
            <td><span class="kpi-name-link" data-kpi-name="${k.kpiName}">${k.kpiName} ›</span></td>
            <td>${bandPill(k.band, k.hasData)}</td>
            <td class="${k.hasData ? `actual-${k.band}` : ""}">${k.hasData ? formatCurrency(k.payoutUsd) : "—"}</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
    <p class="tile-sub" style="margin-top:6px;">Target and Actual values aren't in the data feed yet — score band and payout are live.</p>

    <div class="quarterly-trend-card">
      <p class="section-title" style="margin-bottom:6px;">Quarterly Trend</p>
      <div class="quarterly-trend-bars">
        <div class="quarterly-trend-bar-col">
          <span class="quarterly-trend-bar-amount">${formatCurrency(role.totalPayoutUsd)}</span>
          <div class="quarterly-trend-bar" style="height:${Math.max(8, Math.round((role.percentOfMax / 100) * 80))}px;"></div>
          <span class="quarterly-trend-bar-label">${tpRolesData.period || "This quarter"}</span>
        </div>
      </div>
      <p class="quarterly-trend-note">Trend builds as each quarter is captured — next quarter will appear here so you can compare progress over time.</p>
    </div>

    <div class="bonus-summary">
      <p class="section-title" style="margin-bottom:6px;">Quarterly Bonus Estimate</p>
      <div class="big-row">
        <span class="big">${formatCurrency(role.totalPayoutUsd)}</span>
        <span style="font-size:14px;color:var(--text-muted);font-weight:600;">of ${formatCurrency(role.maxBonusUsd)} max (${pctText})</span>
      </div>
      <p class="tile-sub" style="margin-top:6px;">Formula: each scored KPI's share of the max bonus, weighted by score band. KPIs with no data yet don't count toward or against the total.</p>
    </div>

    <div class="legend-row">
      <span class="legend-row-item"><span class="legend-dot band-best"></span><span class="band-pill band-best">BEST</span> meets/exceeds target — full share</span>
      <span class="legend-row-item"><span class="legend-dot band-better"></span><span class="band-pill band-better">BETTER</span> within 10% of target — 66.7%</span>
      <span class="legend-row-item"><span class="legend-dot band-good"></span><span class="band-pill band-good">GOOD</span> within 20% of target — 33.3%</span>
      <span class="legend-row-item"><span class="legend-dot band-red"></span><span class="band-pill band-red">RED</span> missed by more than 20% — $0</span>
      <span class="legend-row-item"><span class="legend-dot band-none"></span><span class="band-pill band-none">NO DATA</span> excluded from scoring</span>
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
          `/api/team-performance/kpi-explain/${encodeURIComponent(kpiName)}?period=${getStoredPeriod()}`
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

function bandPill(band, hasData) {
  if (!hasData || !band) return `<span class="band-pill band-none">No data</span>`;
  const labels = { best: "Best", better: "Better", good: "Good", red: "Red" };
  return `<span class="band-pill band-${band}">${labels[band]}</span>`;
}
