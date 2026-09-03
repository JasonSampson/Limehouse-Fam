// Shared admin sidebar, injected into any page that has an empty
// <nav id="sidebar-root"></nav> placeholder. This app has no build step and
// no templating engine (see README/CLAUDE.md — plain HTML/CSS/vanilla JS by
// design), so a small JS partial like this is the simplest way to keep one
// piece of nav markup in sync across every admin page instead of copy-pasting
// the same <nav> block into dashboard.html, admin.html, documents.html, etc.
//
// Usage: include this script, then call renderSidebar({ activePage, user })
// after fetching /api/auth/me. "user" is the object from that endpoint, used
// only for the LimeHQ launcher link (limehqUrl) — the sidebar intentionally
// does not surface who's logged in or a per-app sign-out (confirmed with
// Jason: with only 7 staff total, nobody shares accounts, and "sign out of
// just this app" while staying logged into LimeHQ isn't useful). "activePage"
// is one of the NAV_SECTIONS hrefs below, used only to highlight the current
// link.
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
  chat: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H6l-3 3v-3H3.5A1.5 1.5 0 0 1 2 9.5z"/></svg>',
};

// statKey maps a nav item to a field on GET /api/admin/dashboard-stats, used
// to populate its right-aligned count badge. Items with no statKey (Upload
// Document) simply show no badge, matching the reference tool.
const NAV_SECTIONS = [
  {
    label: "Workspace",
    items: [
      { href: "/dashboard.html", label: "Dashboard", icon: "grid" },
      { href: "/chat.html", label: "Chat - Ask Limona", icon: "chat" },
    ],
  },
  {
    label: "Knowledge Base",
    items: [
      { href: "/admin.html", label: "Upload Document", icon: "upload", requiredPermission: "limona.documents.manage" },
      // CHANGED [today], per Jason directly: Document Library and Assets are
      // open to anyone with Limona access — only uploading/editing/removing
      // (Upload Document above, and the manage-only controls within these
      // two pages themselves) stays limona.documents.manage-gated.
      { href: "/documents.html", label: "Document Library", icon: "book", statKey: "documentsCount" },
      { href: "/assets.html", label: "Assets", icon: "download", statKey: "assetsCount" },
      // "Create New SOP" intentionally omitted — separate tool, out of scope
      // (confirmed with Jason).
      { href: "/team-knowledge.html", label: "Team Knowledge", icon: "diamond", statKey: "teamKnowledgeCount", requiredPermission: "limona.answers.contribute" },
    ],
  },
  // Users section removed — staff management is now handled in LimeHQ (/staff).
  {
    label: "Insights",
    items: [{ href: "/reporting.html", label: "Reporting", icon: "bars", statKey: "knowledgeGapsCount", requiredPermission: "limona.documents.manage" }],
  },
];

// CHANGED [today]: renderSidebar is only ever called on a page the caller
// already passed its own requirePermission gate for, so this used to be
// safe to show unconditionally — every page behind it required the same
// single "admin" flag. Now that Upload Document/Document Library/Assets/
// Reporting (limona.documents.manage) and Team Knowledge
// (limona.answers.contribute) are two independently grantable permissions,
// someone holding only one could see a nav link for the other and get
// bounced on click — the same "tab shows, access denied" bug just fixed on
// Dashboard. Filtering each item by the real permissions list closes that.
function renderSidebar({ activePage, user }) {
  const root = document.getElementById("sidebar-root");
  if (!root) return;
  const permissions = user?.permissions || [];

  const sectionsHtml = NAV_SECTIONS.map((section) => {
    const visibleItems = section.items.filter(
      (item) => !item.requiredPermission || permissions.includes(item.requiredPermission)
    );
    if (visibleItems.length === 0) return "";
    const itemsHtml = visibleItems
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

  const limehqHref = (user?.limehqUrl || "#") + "/launcher";
  root.innerHTML = `
    <div class="sidebar-mascot">
      <img src="/images/limona-avatar.png" alt="Limona" class="sidebar-mascot-icon" />
      <span class="sidebar-mascot-name">Limona</span>
    </div>
    <div class="sidebar-brand">
      <a href="${limehqHref}" style="display:inline-flex;align-items:center;text-decoration:none">
        <img src="/images/limehq-logo.png" alt="LimeHQ" style="height:44px;width:auto" />
      </a>
    </div>
    <div class="sidebar-nav">${sectionsHtml}</div>
  `;

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

  document.querySelectorAll(".sidebar-link-badge[data-stat-key]").forEach((el) => {
    const key = el.getAttribute("data-stat-key");
    if (!key || !(key in stats)) return;
    el.textContent = String(stats[key]);
  });
}
