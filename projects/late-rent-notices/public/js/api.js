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

// MM/DD/YYYY everywhere a person sees a date — Jason's standard (matches
// the notice documents themselves).
function fmtDate(d) {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
}

function fmtDateTime(d) {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" });
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
      <a href="${escapeHtml(me.limehqUrl)}/launcher" class="brand-link" style="display:inline-flex;align-items:center;text-decoration:none">
        <img src="/images/limehq-logo.png" alt="LimeHQ" style="height:44px;width:auto;display:block" />
      </a>
      <div class="user-menu">
        <button class="user-menu-trigger" id="user-menu-btn" type="button" aria-haspopup="true" aria-expanded="false">
          ${escapeHtml(me.displayName)} <span class="user-menu-caret">&#9662;</span>
        </button>
        <div class="user-menu-dropdown" id="user-menu-dropdown">
          <span class="user-menu-role">${escapeHtml(roleLabel)}</span>
          <button class="user-menu-item user-menu-signout" id="logout-btn" type="button">Sign out</button>
        </div>
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

  // Same open/close behavior as LimeHQ's own user menu (public/js/nav.js
  // there): click the name to toggle, click anywhere else to close.
  const menuBtn = document.getElementById("user-menu-btn");
  const menuDropdown = document.getElementById("user-menu-dropdown");
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuDropdown.classList.toggle("open");
    menuBtn.setAttribute("aria-expanded", String(menuDropdown.classList.contains("open")));
  });
  document.addEventListener("click", () => {
    menuDropdown.classList.remove("open");
    menuBtn.setAttribute("aria-expanded", "false");
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
