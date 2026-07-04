// Renders the shared header (title, sync status, units summary, period
// selector, Sync Now button, tabs) on all 3 tabs. Each page's HTML has an
// empty <header id="app-header"></header> that this fills in.

function renderHeader(activeTab) {
  const el = document.getElementById("app-header");
  const period = getStoredPeriod();

  el.innerHTML = `
    <p class="app-title">Limehouse PM — Dashboard</p>
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
    <nav class="tabs">
      <a href="/index.html" class="${activeTab === "dashboard" ? "active" : ""}">Dashboard</a>
      <a href="/team-performance.html" class="${activeTab === "team" ? "active" : ""}">Team Performance</a>
      <a href="/ceo-view.html" class="${activeTab === "ceo" ? "active" : ""}">CEO View</a>
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

  loadSyncStatus();
  loadUnitsSummary();
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
