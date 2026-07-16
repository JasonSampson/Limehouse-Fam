// Shared helpers for every page: talking to the API, handling auth
// failures the same way everywhere, and building the top nav bar based on
// who's signed in. Plain vanilla JS, no framework, no build step.

const LimehouseAPI = (() => {
  async function call(path, options = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      ...options,
    });

    if (res.status === 401) {
      // Session missing or expired — send them to sign in rather than
      // showing a raw error on the page.
      window.location.href = "/login.html?reason=expired";
      throw new Error("Not signed in");
    }

    let body = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
    }

    if (!res.ok) {
      const err = new Error((body && body.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.body = body;
      throw err;
    }

    return body;
  }

  return {
    get: (path) => call(path),
    post: (path, data) => call(path, { method: "POST", body: JSON.stringify(data ?? {}) }),
    patch: (path, data) => call(path, { method: "PATCH", body: JSON.stringify(data ?? {}) }),
  };
})();

// Plain-English error text for the handful of failure shapes the API can
// hand back, so the user never sees "Error 500" or a JSON blob.
function friendlyError(err) {
  if (!err) return "Something went wrong. Please try again.";
  if (err.status === 403) {
    return err.body?.error || "You don't have permission to do that.";
  }
  if (err.status === 404) {
    return err.body?.error || "That record couldn't be found — it may not be visible to your account.";
  }
  if (err.status === 409) {
    return err.body?.error || "That action can't be completed right now.";
  }
  if (err.status === 429) {
    return err.body?.error || "That limit has been reached. Contact Jason.";
  }
  if (err.status >= 500) {
    return "Something went wrong on our end. Nothing was changed — please try again, or contact Jason if it keeps happening.";
  }
  return err.body?.error || err.message || "Something went wrong. Please try again.";
}

function fmtMoney(n) {
  const num = typeof n === "string" ? parseFloat(n) : n;
  if (Number.isNaN(num)) return "$0.00";
  return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtDate(d) {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateTime(d) {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// Loads /api/me, renders the shared top bar + shadow-mode banner, and
// returns the profile so the page can also do its own role-based logic.
async function initLayout(activeTab) {
  const root = document.getElementById("app-header");
  if (!root) return null;

  let me;
  try {
    me = await LimehouseAPI.get("/api/me");
  } catch (err) {
    return null; // call() already redirected to /login.html on 401
  }

  const roleLabel = {
    pm: "Portfolio Manager",
    admin_assistant: "Admin Assistant",
    bookkeeping: "Bookkeeping Coordinator",
  }[me.role] || me.role;

  const tabs = [
    { href: "/index.html", key: "dashboard", label: "Delinquency Dashboard" },
    { href: "/contact-log.html", key: "contact-log", label: "Contact History" },
  ];

  root.innerHTML = `
    <header class="topbar">
      <a href="${escapeHtml(me.limehqUrl)}/launcher" class="brand-link" style="display:inline-flex;align-items:center;gap:0.35rem;text-decoration:none;font-weight:700;font-size:1.4rem;line-height:1;letter-spacing:-0.3px">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="width:22px;height:22px;flex-shrink:0"><circle cx="50" cy="50" r="49" fill="#009344"/><circle cx="50" cy="50" r="43" fill="#ffffff"/><circle cx="50" cy="50" r="41" fill="#74b62e"/><line x1="50" y1="9" x2="50" y2="91" stroke="#009344" stroke-width="2.5"/><line x1="50" y1="50" x2="86.8" y2="26.8" stroke="#009344" stroke-width="2.5"/><line x1="50" y1="50" x2="13.2" y2="26.8" stroke="#009344" stroke-width="2.5"/><line x1="50" y1="50" x2="13.2" y2="73.2" stroke="#009344" stroke-width="2.5"/><line x1="50" y1="50" x2="86.8" y2="73.2" stroke="#009344" stroke-width="2.5"/><circle cx="50" cy="50" r="5" fill="#009344"/></svg>
        <span style="color:#74b62e">lime</span><span style="color:#009344">HQ</span>
      </a>
      <div class="who">
        ${escapeHtml(me.displayName)} &middot; ${escapeHtml(roleLabel)}
        <button id="logout-btn" type="button">Sign out</button>
      </div>
    </header>
    ${me.shadowMode ? `<div class="shadow-banner">SHADOW MODE: this system is in test mode. No notices are actually emailed to tenants, no matter what a button says.</div>` : ""}
    <main>
      <nav class="tabs">
        ${tabs.map((t) => `<a href="${t.href}" class="${t.key === activeTab ? "active" : ""}">${t.label}</a>`).join("")}
        <form id="nav-search-form" class="nav-search" role="search">
          <input type="search" id="nav-search-input" placeholder="Search past notices &amp; history by address…" aria-label="Search by address" />
          <button type="submit">Search</button>
        </form>
      </nav>
      <div id="app-content"></div>
    </main>
  `;

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    window.location.href = "/login.html";
  });

  document.getElementById("nav-search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("nav-search-input").value.trim();
    if (!q) return;
    window.location.href = `/search.html?q=${encodeURIComponent(q)}`;
  });

  return me;
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
