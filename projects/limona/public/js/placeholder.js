// Shared script for the "coming soon" placeholder pages (Assets, Team
// Knowledge, Reporting) — same auth-gate + sidebar-render pattern as every
// other admin page, just with no page-specific data to load. Q will replace
// each placeholder page's markup/script with the real feature; this file
// stays as the pattern to copy from, or can be deleted once none of the
// three placeholders still use it.
(function () {
  // Captured synchronously, before the first await below — document.currentScript
  // is only valid during the initial (non-async) part of script execution.
  const activePage = document.currentScript.dataset.activePage;

  (async function init() {
    const meRes = await fetch("/api/auth/me");
    if (!meRes.ok) {
      window.location.href = "/login.html";
      return;
    }
    const me = await meRes.json();
    if (me.user.role !== "admin") {
      window.location.href = "/chat.html";
      return;
    }

    renderSidebar({ activePage, user: me.user });
  })();
})();
