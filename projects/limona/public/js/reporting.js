const errorEl = document.getElementById("error");

function showError(message) {
  errorEl.textContent = message;
  errorEl.style.display = "block";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
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

  renderSidebar({ activePage: "/reporting.html", user: me.user });

  await Promise.all([loadKnowledgeGaps(), loadMostCommonQuestions(), loadRecentQuestions()]);
}

function renderAskedBy(g) {
  const name = escapeHtml(g.asked_by || "Unknown");
  if (!g.asked_by_email) return name;
  return `${name}<br><span class="muted">${escapeHtml(g.asked_by_email)}</span>`;
}

function renderGapRow(g) {
  return `
    <tr data-id="${g.id}" data-question="${escapeHtml(g.question)}">
      <td><strong>${escapeHtml(g.question)}</strong></td>
      <td>${renderAskedBy(g)}</td>
      <td>${new Date(g.created_at).toLocaleString()}</td>
      <td class="actions-cell"><button class="answer-btn">Answer</button></td>
    </tr>
  `;
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
    tbody.innerHTML = `<tr><td colspan="4" class="muted">No knowledge gaps — nice work.</td></tr>`;
    return;
  }
  tbody.innerHTML = body.gaps.map(renderGapRow).join("");

  tbody.querySelectorAll(".answer-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const row = e.target.closest("tr");
      if (row.querySelector("textarea")) return;
      openAnswerForm(row);
    });
  });
}

function openAnswerForm(row) {
  const id = row.dataset.id;
  const actionsCell = row.querySelector(".actions-cell");

  actionsCell.innerHTML = `
    <div class="gap-answer-form">
      <textarea class="gap-answer-input" rows="3" placeholder="Write the answer staff should get…"></textarea>
      <div>
        <button class="secondary save-answer-btn">Save Answer</button>
        <button class="cancel-answer-btn">Cancel</button>
      </div>
    </div>
  `;

  actionsCell.querySelector(".cancel-answer-btn").addEventListener("click", () => loadKnowledgeGaps());

  actionsCell.querySelector(".save-answer-btn").addEventListener("click", async () => {
    const answer = actionsCell.querySelector(".gap-answer-input").value.trim();
    if (!answer) {
      showError("An answer is required.");
      return;
    }
    const res = await fetch(`/api/admin/reporting/knowledge-gaps/${id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showError(body.error || "Failed to save this answer.");
      return;
    }
    await Promise.all([loadKnowledgeGaps(), loadMostCommonQuestions(), loadRecentQuestions()]);
  });
}

document.getElementById("clear-log-btn").addEventListener("click", async () => {
  if (!confirm("Clear the entire Knowledge Gaps log? This permanently deletes these question records and cannot be undone.")) return;
  const res = await fetch("/api/admin/reporting/knowledge-gaps", { method: "DELETE" });
  if (!res.ok) {
    showError("Failed to clear the log.");
    return;
  }
  await Promise.all([loadKnowledgeGaps(), loadRecentQuestions()]);
});

function renderSourceChips(items) {
  return items.map((i) => `<span class="source-chip">${escapeHtml(i.label)} <span class="count">${i.count}×</span></span>`).join("");
}

function renderCommonQuestion(q, rank) {
  const askerWord = q.askers.length === 1 ? "person" : "people";
  const askerChips = q.askers.map((a) => ({ label: a.name, count: a.count }));

  return `
    <div class="top-q-item" data-question="${escapeHtml(q.question)}">
      <div class="top-q-header-row">
        <div class="top-q-text"><span class="top-q-rank">#${rank}</span><strong>${escapeHtml(q.question)}</strong></div>
        <span class="top-q-count">${q.askCount}× asked</span>
        <button class="secondary remove-common-btn">Remove</button>
      </div>
      <div class="top-q-meta-row">Asked by ${q.askers.length} ${askerWord}</div>
      <div class="top-q-sources">${renderSourceChips(askerChips)}</div>
      <div class="top-q-meta-row">Documents cited</div>
      <div class="top-q-sources">${q.documentsCited.length ? renderSourceChips(q.documentsCited) : '<span class="muted">None</span>'}</div>
    </div>
  `;
}

async function loadMostCommonQuestions() {
  const res = await fetch("/api/admin/reporting/most-common-questions");
  if (!res.ok) {
    showError("Failed to load most common questions.");
    return;
  }
  const body = await res.json();
  const container = document.getElementById("common-questions-list");
  if (body.questions.length === 0) {
    container.innerHTML = `<p class="muted">No answered questions yet.</p>`;
    return;
  }
  container.innerHTML = body.questions.map((q, i) => renderCommonQuestion(q, i + 1)).join("");

  container.querySelectorAll(".remove-common-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const item = e.target.closest(".top-q-item");
      const question = item.dataset.question;
      if (!confirm("Remove this question from Most Common Questions? This permanently deletes every answered record of it and cannot be undone.")) return;
      const res = await fetch("/api/admin/reporting/most-common-questions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) {
        showError("Failed to remove this question.");
        return;
      }
      await Promise.all([loadMostCommonQuestions(), loadRecentQuestions()]);
    });
  });
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
    tbody.innerHTML = `<tr><td colspan="5" class="muted">No questions asked yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = body.questions
    .map(
      (q) => `
      <tr data-id="${q.id}">
        <td>${escapeHtml(q.question)}</td>
        <td><span class="badge ${q.answered ? "badge-ready" : "badge-failed"}">${q.answered ? "Yes" : "No"}</span></td>
        <td>${escapeHtml(q.asked_by || "Unknown")}</td>
        <td>${new Date(q.created_at).toLocaleString()}</td>
        <td class="actions-cell"><button class="secondary remove-recent-btn">Remove</button></td>
      </tr>
    `
    )
    .join("");

  tbody.querySelectorAll(".remove-recent-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      if (!confirm("Remove this question? This permanently deletes the record and cannot be undone.")) return;
      const res = await fetch(`/api/admin/reporting/recent-questions/${id}`, { method: "DELETE" });
      if (!res.ok) {
        showError("Failed to remove this question.");
        return;
      }
      await Promise.all([loadRecentQuestions(), loadMostCommonQuestions()]);
    });
  });
}

init();
