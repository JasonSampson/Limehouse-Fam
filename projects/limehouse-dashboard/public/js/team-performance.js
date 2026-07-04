// Tab 2: Team Performance. Password-gated (separate password from the main
// session, per spec) — locked state shows a prompt, correct password sets a
// cookie via /api/team-performance/check-password and unlocks for the rest
// of the session.

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
  checkUnlockedAndRender();
  window.addEventListener("lh:period-changed", checkUnlockedAndRender);
  window.addEventListener("lh:sync-complete", checkUnlockedAndRender);
});

async function checkUnlockedAndRender() {
  const content = document.getElementById("page-content");
  content.innerHTML = `<p class="loading-text">Loading…</p>`;

  try {
    const roles = await apiGet(`/api/team-performance/roles?period=${getStoredPeriod()}`);
    tpRolesData = roles;
    renderUnlockedView();
  } catch (err) {
    if (err.status === 401) {
      renderLockedView();
    } else {
      content.innerHTML = errorBanner(`Couldn't load Team Performance data: ${err.message}`);
    }
  }
}

function renderLockedView() {
  const content = document.getElementById("page-content");
  content.innerHTML = `
    <div class="password-gate">
      <h2>Team Performance</h2>
      <p>Enter password to continue</p>
      <input type="password" id="tp-password-input" placeholder="Password" autocomplete="current-password" />
      <button id="tp-unlock-btn">Unlock</button>
      <p class="password-error" id="tp-password-error"></p>
    </div>
  `;

  const input = document.getElementById("tp-password-input");
  const errorEl = document.getElementById("tp-password-error");
  const unlockBtn = document.getElementById("tp-unlock-btn");

  const attemptUnlock = async () => {
    const password = input.value;
    if (!password) return;
    errorEl.textContent = "";
    unlockBtn.disabled = true;
    try {
      await apiPost("/api/team-performance/check-password", { password });
      await checkUnlockedAndRender();
    } catch (err) {
      errorEl.textContent = "Incorrect password.";
    } finally {
      unlockBtn.disabled = false;
    }
  };

  unlockBtn.addEventListener("click", attemptUnlock);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") attemptUnlock();
  });
  input.focus();
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
        .map(
          (label) =>
            `<button data-role="${label}" class="${label === tpActiveRole ? "active" : ""}">${label}</button>`
        )
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

  detailEl.innerHTML = `
    <p class="role-summary-line">${role.kpis.length} accountability KPIs · $${formatNumber(role.maxBonusUsd)} max quarterly bonus</p>
    <p class="trend-line" style="color:var(--text-muted);">Quarter-over-quarter trend: not connected yet</p>
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
            <td>${k.kpiName}</td>
            <td>${bandPill(k.band, k.hasData)}</td>
            <td>${k.hasData ? formatCurrency(k.payoutUsd) : "—"}</td>
          </tr>
        `
          )
          .join("")}
      </tbody>
    </table>
    <p class="tile-sub" style="margin-top:6px;">Target and Actual values aren't in the data feed yet — score band and payout are live.</p>

    <div class="bonus-summary">
      <p class="section-title" style="margin-bottom:6px;">Quarterly Bonus Estimate</p>
      <div class="big">${formatCurrency(role.totalPayoutUsd)} <span style="font-size:14px;color:var(--text-muted);font-weight:600;">of ${formatCurrency(role.maxBonusUsd)} max (${pctText})</span></div>
      <p class="tile-sub" style="margin-top:6px;">Formula: each scored KPI's share of the max bonus, weighted by score band. KPIs with no data yet don't count toward or against the total.</p>
    </div>

    <div class="legend-row">
      <span><span class="band-pill band-best">BEST</span> meets/exceeds target — full share</span>
      <span><span class="band-pill band-better">BETTER</span> within 10% of target — 66.7%</span>
      <span><span class="band-pill band-good">GOOD</span> within 20% of target — 33.3%</span>
      <span><span class="band-pill band-red">RED</span> missed by more than 20% — $0</span>
      <span><span class="band-pill band-none">NO DATA</span> excluded from scoring</span>
    </div>
  `;
}

function bandPill(band, hasData) {
  if (!hasData || !band) return `<span class="band-pill band-none">No data</span>`;
  const labels = { best: "Best", better: "Better", good: "Good", red: "Red" };
  return `<span class="band-pill band-${band}">${labels[band]}</span>`;
}
