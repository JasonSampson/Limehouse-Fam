const errorEl = document.getElementById("error");

function showError(message) {
  errorEl.textContent = message;
  errorEl.style.display = "block";
}

async function init() {
  const meRes = await fetch("/api/auth/me");
  if (!meRes.ok) {
    window.location.href = "/auth/login";
    return;
  }
  const me = await meRes.json();
  if (me.user.role !== "admin") {
    window.location.href = "/chat.html";
    return;
  }

  renderSidebar({ activePage: "/dashboard.html", user: me.user });

  await loadStats();
}

async function loadStats() {
  const res = await fetch("/api/admin/dashboard-stats");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    showError(body.error || "Failed to load dashboard stats.");
    return;
  }
  const stats = await res.json();

  document.getElementById("stat-documents").textContent = stats.documentsCount;
  document.getElementById("stat-gaps").textContent = stats.knowledgeGapsCount;
  document.getElementById("stat-questions").textContent = stats.questionsAskedCount;
  // Team members stat removed — user management has moved to LimeHQ.
  const teamEl = document.getElementById("stat-team");
  if (teamEl) teamEl.closest(".stat-card")?.remove();
}

init();
