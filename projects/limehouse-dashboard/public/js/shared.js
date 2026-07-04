// Shared helpers used by dashboard.js, team-performance.js, ceo-view.js.
// Plain vanilla JS on purpose — this is a small internal tool, no build step.

const PERIOD_LABELS = {
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  last_quarter: "Last quarter",
  this_year: "This year",
  last_year: "Last year",
};

function getStoredPeriod() {
  return localStorage.getItem("lh_period") || "this_month";
}

function setStoredPeriod(period) {
  localStorage.setItem("lh_period", period);
}

async function apiGet(path) {
  const res = await fetch(path, { credentials: "same-origin" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.detail = body.detail;
    throw err;
  }
  return body;
}

async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.detail = body.detail;
    throw err;
  }
  return body;
}

function formatCurrency(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  const formatted = abs.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  return n < 0 ? `(${formatted})` : formatted;
}

function formatPercent(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US");
}

function formatDateTime(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatDateRange(range) {
  if (!range) return "";
  const from = new Date(range.from + "T00:00:00");
  const to = new Date(range.to + "T00:00:00");
  const opts = { month: "short", day: "numeric" };
  return `${from.toLocaleDateString("en-US", opts)} – ${to.toLocaleDateString("en-US", opts)}, ${to.getFullYear()}`;
}

function badgeHtml(sourceTag, live) {
  const tags = Array.isArray(sourceTag) ? sourceTag : [sourceTag];
  let html = tags.map((t) => `<span class="badge">${t}</span>`).join("");
  if (live) html += `<span class="badge live">LIVE</span>`;
  return `<span class="tile-badges">${html}</span>`;
}

// Renders one metric tile. `opts.value === undefined` means "not connected
// yet" — shown honestly instead of faking a number.
function tileHtml(opts) {
  const {
    id,
    label,
    value,
    sub,
    sourceTags = [],
    live = false,
    clickable = false,
    yoy = null, // { direction: 'up'|'down', text: '...' }
    pending = null, // text shown with an hourglass, e.g. Doors Added
    notConnected = false,
    notConnectedReason = "Not connected yet",
  } = opts;

  const classes = ["tile"];
  if (clickable && !notConnected) classes.push("clickable");
  if (notConnected) classes.push("disconnected");

  const valueHtml = notConnected
    ? `<div class="tile-value not-connected">${notConnectedReason}</div>`
    : `<div class="tile-value">${value}</div>`;

  const subHtml = sub && !notConnected ? `<div class="tile-sub">${sub}</div>` : "";
  const yoyHtml =
    yoy && !notConnected ? `<div class="tile-yoy ${yoy.direction}">${yoy.text}</div>` : "";
  const pendingHtml = pending && !notConnected ? `<div class="tile-pending">⏳ ${pending}</div>` : "";

  return `
    <div class="${classes.join(" ")}" ${clickable && !notConnected ? `data-tile-id="${id}"` : ""}>
      <div class="tile-top">
        <span class="tile-label">${label}</span>
        ${badgeHtml(sourceTags, live && !notConnected)}
      </div>
      ${valueHtml}
      ${subHtml}
      ${yoyHtml}
      ${pendingHtml}
    </div>
  `;
}

function notConnectedBox(title, reason) {
  return `<div class="not-connected-box"><strong>${title}</strong>${reason}</div>`;
}

function errorBanner(message) {
  return `<div class="error-banner">${message}</div>`;
}
