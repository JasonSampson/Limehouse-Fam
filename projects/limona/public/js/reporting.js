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

  renderSidebar({ activePage: "/reporting.html", user: me.user });

  await Promise.all([loadKnowledgeGaps(), loadRecentQuestions()]);
}

async function loadKnowledgeGaps() {
  const res = await fetch("/api/admin/reporting/knowledge-gaps");
  if (!res.ok) {
    showError("Failed to load knowledge gaps.");
    return;
  }
  const body = await res.json();
  const tbody = document.getElementById("gaps-body");
  if (body.gaps.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">No knowledge gaps — nice work.</td></tr>`;
    return;
  }
  tbody.innerHTML = body.gaps
    .map(
      (g) => `
      <tr>
        <td>${g.question}</td>
        <td>${g.asked_by || "Unknown"}</td>
        <td>${new Date(g.created_at).toLocaleString()}</td>
      </tr>
    `
    )
    .join("");
}

async function loadRecentQuestions() {
  const res = await fetch("/api/admin/reporting/recent-questions");
  if (!res.ok) {
    showError("Failed to load recent questions.");
    return;
  }
  const body = await res.json();
  const tbody = document.getElementById("questions-body");
  if (body.questions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">No questions asked yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = body.questions
    .map(
      (q) => `
      <tr>
        <td>${q.question}</td>
        <td><span class="badge ${q.answered ? "badge-ready" : "badge-failed"}">${q.answered ? "Yes" : "No"}</span></td>
        <td>${q.asked_by || "Unknown"}</td>
        <td>${new Date(q.created_at).toLocaleString()}</td>
      </tr>
    `
    )
    .join("");
}

init();
