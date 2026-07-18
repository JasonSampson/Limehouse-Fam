// Renders the shared header (title, sync status, units summary, period
// selector, Sync Now button, tabs) on all 3 tabs. Each page's HTML has an
// empty <header id="app-header"></header> that this fills in.

function renderHeader(activeTab) {
  const el = document.getElementById("app-header");
  const period = getStoredPeriod();

  el.innerHTML = `
    <div class="app-brand">
      <a href="#" id="limehq-home-link" style="display:inline-flex;align-items:center;gap:0.35rem;text-decoration:none;font-weight:700;font-size:1.4rem;line-height:1;letter-spacing:-0.3px">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="width:22px;height:22px;flex-shrink:0"><circle cx="50" cy="50" r="49" fill="#009344"/><circle cx="50" cy="50" r="43" fill="#ffffff"/><circle cx="50" cy="50" r="41" fill="#74b62e"/><line x1="50" y1="9" x2="50" y2="91" stroke="#009344" stroke-width="2.5"/><line x1="50" y1="50" x2="86.8" y2="26.8" stroke="#009344" stroke-width="2.5"/><line x1="50" y1="50" x2="13.2" y2="26.8" stroke="#009344" stroke-width="2.5"/><line x1="50" y1="50" x2="13.2" y2="73.2" stroke="#009344" stroke-width="2.5"/><line x1="50" y1="50" x2="86.8" y2="73.2" stroke="#009344" stroke-width="2.5"/><circle cx="50" cy="50" r="5" fill="#009344"/></svg>
        <span style="color:#74b62e">lime</span><span style="color:#009344">HQ</span>
      </a>
      <button class="logout-btn" id="logout-btn">Log out</button>
    </div>
    <div class="sync-line">
      <span id="sync-status">Checking sync status…</span>
      <span class="units-summary" id="units-summary"></span>
    </div>
    <div class="header-controls">
      <select id="period-select">
        ${Object.entries(PERIOD_LABELS)
          .map(([val, label]) => `<option value="${val}" ${val === period ? "selected" : ""}>${label}</option>`)
          .join("")}
      </select>
      <button class="sync-now-btn" id="sync-now-btn">Sync now</button>
    </div>
    <nav class="tabs" id="app-tabs">
      <a href="/index.html" class="${activeTab === "dashboard" ? "active" : ""}">Dashboard</a>
    </nav>
  `;

  document.getElementById("period-select").addEventListener("change", (e) => {
    setStoredPeriod(e.target.value);
    window.dispatchEvent(new CustomEvent("lh:period-changed", { detail: e.target.value }));
  });

  document.getElementById("sync-now-btn").addEventListener("click", async () => {
    const btn = document.getElementById("sync-now-btn");
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Syncing…";
    try {
      await apiPost("/api/sync/now");
      await loadSyncStatus();
      window.dispatchEvent(new CustomEvent("lh:sync-complete"));
    } catch (err) {
      const statusEl = document.getElementById("sync-status");
      statusEl.textContent = `Sync failed: ${err.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  document.getElementById("logout-btn").addEventListener("click", async () => {
    try {
      await apiPost("/auth/logout");
    } finally {
      window.location.href = "/login.html";
    }
  });

  loadSyncStatus();
  loadUnitsSummary();
  renderAdminOnlyTabs(activeTab);
}

// Team Performance and CEO View are Admin-only — Staff-role users should
// not even see a disabled link to a page they can't open, so these are
// appended only after /api/me confirms the role, not hidden via CSS.
// Manage Staff REMOVED 2026-07-19, per Jason directly — staff accounts and
// access are now managed centrally in LimeHQ's own "Staff & Permissions"
// screen instead of a separate one here.
async function renderAdminOnlyTabs(activeTab) {
  try {
    const me = await apiGet("/api/me");
    const homeLink = document.getElementById("limehq-home-link");
    if (homeLink && me.limehqUrl) homeLink.href = me.limehqUrl + "/launcher";
    if (me.role !== "admin") return;

    const tabs = document.getElementById("app-tabs");
    tabs.insertAdjacentHTML(
      "beforeend",
      `
      <a href="/team-performance.html" class="${activeTab === "team" ? "active" : ""}">Team Performance</a>
      <a href="/ceo-view.html" class="${activeTab === "ceo" ? "active" : ""}">CEO View</a>
    `
    );
  } catch (err) {
    // Not signed in (shouldn't happen — the server redirects to /login.html
    // first) or /api/me failed; either way, just leave Dashboard-only nav.
  }
}

async function loadSyncStatus() {
  const statusEl = document.getElementById("sync-status");
  if (!statusEl) return;
  try {
    const status = await apiGet("/api/sync/status");
    const parts = [];
    if (status.buildium) parts.push(`Buildium synced ${formatDateTime(status.buildium.lastSyncedAt)}`);
    if (status.rentEngine && !status.rentEngine.connected) parts.push("RentEngine not connected");
    if (status.leadSimple && !status.leadSimple.connected) parts.push("LeadSimple not connected");
    statusEl.textContent = `Synced: ${parts.join(" · ")}`;
  } catch (err) {
    statusEl.textContent = "Sync status unavailable";
  }
}

async function loadUnitsSummary() {
  const el = document.getElementById("units-summary");
  if (!el) return;
  try {
    const [occupancy, leaseMix] = await Promise.all([
      apiGet("/api/dashboard/occupancy"),
      apiGet("/api/dashboard/lease-mix"),
    ]);
    el.textContent = `${formatNumber(occupancy.totalUnits)} units · ${formatNumber(leaseMix.totalActiveLeaseCount)} leases`;
  } catch (err) {
    el.textContent = "";
  }
}
