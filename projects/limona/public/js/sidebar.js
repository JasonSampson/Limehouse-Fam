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

const NAV_SECTIONS = [
  {
    label: "Workspace",
    items: [
      { href: "/dashboard.html", label: "Dashboard" },
      // "Create New SOP" intentionally omitted — separate tool, out of scope
      // (confirmed with Jason).
      { href: "/admin.html", label: "Upload Document" },
      { href: "/documents.html", label: "Document Library" },
      { href: "/assets.html", label: "Assets" },
      { href: "/team-knowledge.html", label: "Team Knowledge" },
    ],
  },
  {
    label: "Team",
    items: [{ href: "/users.html", label: "Users" }],
  },
  {
    label: "Insights",
    items: [{ href: "/reporting.html", label: "Reporting" }],
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
        return `<a class="sidebar-link${isActive ? " active" : ""}" href="${item.href}">${item.label}</a>`;
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
    <div class="sidebar-brand"><img src="/images/limona-avatar.png" alt="" class="sidebar-brand-icon" />Limona</div>
    <div class="sidebar-nav">${sectionsHtml}</div>
    <div class="sidebar-account">
      <div class="sidebar-avatar">${initialsFor(user?.name)}</div>
      <div class="sidebar-account-info">
        <div class="sidebar-account-name">${user?.name || ""}</div>
        <div class="sidebar-account-email">${user?.email || ""}</div>
      </div>
      <a href="#" id="sidebar-signout" class="sidebar-signout">Sign out</a>
    </div>
  `;

  document.getElementById("sidebar-signout").addEventListener("click", async (e) => {
    e.preventDefault();
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login.html";
  });
}
