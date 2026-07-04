const errorEl = document.getElementById("error");

function showError(message) {
  errorEl.textContent = message;
  errorEl.style.display = "block";
}

async function init() {
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
  // admin + member (counted by role, any status) already covers every user
  // row exactly once. invited is a status subset of one of those two role
  // counts, not additional people, so it is NOT added into the total.
  document.getElementById("stat-team").textContent = stats.teamMembers.admin + stats.teamMembers.member;
  document.getElementById("stat-team-sub").textContent =
    `${stats.teamMembers.admin} admin, ${stats.teamMembers.member} member · ${stats.teamMembers.invited} pending invite`;
}

init();
