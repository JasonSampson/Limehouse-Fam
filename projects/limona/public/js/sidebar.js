// Shared admin sidebar, injected into any page that has an empty
// <nav id="sidebar-root"></nav> placeholder. This app has no build step and
// no templating engine (see README/CLAUDE.md — plain HTML/CSS/vanilla JS by
// design), so a small JS partial like this is the simplest way to keep one
// piece of nav markup in sync across every admin page instead of copy-pasting
// the same <nav> block into dashboard.html, admin.html, documents.html, etc.
//
// Usage: include this script, then call renderSidebar({ activePage, user })
// after fetching /api/auth/me. "user" is the object from that endpoint
// ({ name, email, ... }); "activePage" is one of the NAV_ITEMS hrefs below,
// used only to highlight the current link.
//
// Icons are small hand-written inline SVGs (line-style, 16x16, stroke
// currentColor) rather than an icon font/library — keeps the no-build-step,
// no-new-dependency convention intact. Count badges (e.g. "Document Library
// 46") are wired to /api/admin/dashboard-stats, the same read-only endpoint
// the Dashboard stat cards already use.

const ICONS = {
  grid: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1"/><rect x="9" y="9" width="5.5" height="5.5" rx="1"/></svg>',
  upload: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.5V2"/><path d="M4.5 5.5 8 2l3.5 3.5"/><path d="M2 10.5v2a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-2"/></svg>',
  book: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2.75A1.75 1.75 0 0 1 3.75 1H8v13H3.75A1.75 1.75 0 0 0 2 15.75z"/><path d="M14 2.75A1.75 1.75 0 0 0 12.25 1H8v13h4.25A1.75 1.75 0 0 1 14 15.75z"/></svg>',
  download: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8.5"/><path d="M4.5 7.5 8 11l3.5-3.5"/><path d="M2 13h12"/></svg>',
  diamond: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4.5 2h7L14 6.5 8 14 2 6.5z"/><path d="M2 6.5h12"/></svg>',
  people: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="5" r="2"/><path d="M1.5 14c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M9.8 10.6c.5-.2 1.1-.3 1.7-.3 2.2 0 4 1.3 4 3.5"/></svg>',
  bars: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14V8.5"/><path d="M8 14V2"/><path d="M13 14v-5"/><path d="M1.5 14h13"/></svg>',
};

// statKey maps a nav item to a field on GET /api/admin/dashboard-stats, used
// to populate its right-aligned count badge. Items with no statKey (Upload
// Document) simply show no badge, matching the reference tool.
const NAV_SECTIONS = [
  {
    label: "Workspace",
    items: [{ href: "/dashboard.html", label: "Dashboard", icon: "grid" }],
  },
  {
    label: "Knowledge Base",
    items: [
      { href: "/admin.html", label: "Upload Document", icon: "upload" },
      { href: "/documents.html", label: "Document Library", icon: "book", statKey: "documentsCount" },
      { href: "/assets.html", label: "Assets", icon: "download", statKey: "assetsCount" },
      // "Create New SOP" intentionally omitted — separate tool, out of scope
      // (confirmed with Jason).
      { href: "/team-knowledge.html", label: "Team Knowledge", icon: "diamond", statKey: "teamKnowledgeCount" },
    ],
  },
  {
    label: "Team",
    items: [{ href: "/users.html", label: "Users", icon: "people", statKey: "teamMembersTotal" }],
  },
  {
    label: "Insights",
    items: [{ href: "/reporting.html", label: "Reporting", icon: "bars", statKey: "knowledgeGapsCount" }],
  },
];

function initialsFor(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

function renderSidebar({ activePage, user }) {
  const root = document.getElementById("sidebar-root");
  if (!root) return;

  const sectionsHtml = NAV_SECTIONS.map((section) => {
    const itemsHtml = section.items
      .map((item) => {
        const isActive = item.href === activePage;
        const icon = ICONS[item.icon] || "";
        return `<a class="sidebar-link${isActive ? " active" : ""}" href="${item.href}">
          <span class="sidebar-link-icon">${icon}</span>
          <span class="sidebar-link-label">${item.label}</span>
          <span class="sidebar-link-badge" data-stat-key="${item.statKey || ""}" style="display:${item.statKey ? "inline-block" : "none"};"></span>
        </a>`;
      })
      .join("");
    return `
      <div class="sidebar-section">
        <div class="sidebar-section-label">${section.label}</div>
        ${itemsHtml}
      </div>
    `;
  }).join("");

  root.innerHTML = `
    <div class="sidebar-mascot">
      <img src="/images/limona-avatar.png" alt="Limona" class="sidebar-mascot-icon" />
      <span class="sidebar-mascot-name">Limona</span>
    </div>
    <div class="sidebar-brand">
      <img src="/images/limehouse-logo.png" alt="Limehouse Property Management" class="sidebar-brand-icon" />
      <div class="sidebar-brand-text">
        <div class="sidebar-brand-name">Limehouse</div>
        <div class="sidebar-brand-subtitle">Admin</div>
      </div>
    </div>
    <div class="sidebar-nav">${sectionsHtml}</div>
    <div class="sidebar-account">
      <div class="sidebar-avatar">${initialsFor(user?.name)}</div>
      <div class="sidebar-account-info">
        <div class="sidebar-account-name">${user?.name || ""}</div>
        <div class="sidebar-account-email">${user?.email || ""}</div>
      </div>
      <div class="sidebar-account-actions">
        <a href="/chat.html" class="sidebar-account-btn">Chat</a>
        <a href="#" id="sidebar-signout" class="sidebar-account-btn">Out</a>
      </div>
    </div>
  `;

  document.getElementById("sidebar-signout").addEventListener("click", async (e) => {
    e.preventDefault();
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });

  loadSidebarCounts();
}

// Fetches the same read-only admin dashboard-stats endpoint the Dashboard
// stat cards use, and fills in each nav item's count badge. Silently no-ops
// on failure (e.g. non-admin viewers never call renderSidebar with badges
// relevant to them anyway) so a slow/failed stats call never blocks nav
// rendering, which already happened above.
async function loadSidebarCounts() {
  let stats;
  try {
    const res = await fetch("/api/admin/dashboard-stats");
    if (!res.ok) return;
    stats = await res.json();
  } catch {
    return;
  }

  stats.teamMembersTotal = (stats.teamMembers?.admin || 0) + (stats.teamMembers?.member || 0);

  document.querySelectorAll(".sidebar-link-badge[data-stat-key]").forEach((el) => {
    const key = el.getAttribute("data-stat-key");
    if (!key || !(key in stats)) return;
    el.textContent = String(stats[key]);
  });
}
