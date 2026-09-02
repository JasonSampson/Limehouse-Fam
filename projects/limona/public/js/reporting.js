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
  if (!me.user.permissions.includes("limona.documents.manage")) {
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
  // Limona's draft is stored server-side (chat_queries.draft_answer) and
  // never shown to the staffer who asked — it only ever appears here, for an
  // admin to Approve as-is, Edit then approve, or Reject. A gap with no
  // draft (e.g. drafting failed, or there were no documents at all to draw
  // from) falls back to the plain "Answer from scratch" button.
  const draftPreview = g.draft_answer
    ? `<div class="gap-draft-preview"><span class="gap-draft-label">Limona's draft</span>${escapeHtml(g.draft_answer)}</div>`
    : "";
  const actionButtons = g.draft_answer
    ? `<button class="approve-draft-btn">Approve</button><button class="secondary edit-draft-btn">Edit</button><button class="danger reject-draft-btn">Reject</button>`
    : `<button class="answer-btn">Answer</button>`;

  return `
    <tr data-id="${g.id}" data-question="${escapeHtml(g.question)}" data-draft="${escapeHtml(g.draft_answer || "")}">
      <td data-label="Question"><strong>${escapeHtml(g.question)}</strong>${draftPreview}</td>
      <td data-label="Asked by">${renderAskedBy(g)}</td>
      <td data-label="When">${new Date(g.created_at).toLocaleString()}</td>
      <td class="actions-cell">${actionButtons}</td>
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

  tbody.querySelectorAll(".answer-btn, .edit-draft-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const row = e.target.closest("tr");
      if (row.querySelector("textarea")) return;
      openAnswerForm(row, row.dataset.draft);
    });
  });

  tbody.querySelectorAll(".approve-draft-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const row = e.target.closest("tr");
      const res = await fetch(`/api/admin/reporting/knowledge-gaps/${row.dataset.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: row.dataset.draft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showError(body.error || "Failed to approve this draft.");
        return;
      }
      await Promise.all([loadKnowledgeGaps(), loadMostCommonQuestions(), loadRecentQuestions()]);
    });
  });

  tbody.querySelectorAll(".reject-draft-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const row = e.target.closest("tr");
      if (!confirm("Dismiss Limona's suggested draft? The question stays open, but you'll need to write the answer yourself.")) return;
      const res = await fetch(`/api/admin/reporting/knowledge-gaps/${row.dataset.id}/reject-draft`, {
        method: "POST",
      });
      if (!res.ok) {
        showError("Failed to reject this draft.");
        return;
      }
      await loadKnowledgeGaps();
    });
  });
}

function openAnswerForm(row, initialValue) {
  const id = row.dataset.id;
  const actionsCell = row.querySelector(".actions-cell");

  actionsCell.innerHTML = `
    <div class="gap-answer-form">
      <textarea class="gap-answer-input" rows="3" placeholder="Write the answer staff should get…">${escapeHtml(initialValue || "")}</textarea>
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

  // A genuine repeat (asked 2+ times) that isn't already a Team Knowledge
  // entry gets a one-click suggestion to lock it in as the official answer,
  // instead of Limona re-searching documents for it every time.
  let promoteHtml = "";
  if (q.alreadyInTeamKnowledge) {
    promoteHtml = `<div class="top-q-promote top-q-promote-done">✓ Saved to Team Knowledge</div>`;
  } else if (q.askCount >= 2) {
    promoteHtml = `
      <div class="top-q-promote">
        <span>This has been asked ${q.askCount} times — want to lock this in as an official answer?</span>
        <button class="secondary promote-btn">Save as Team Knowledge</button>
      </div>
    `;
  }

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
      ${promoteHtml}
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

  container.querySelectorAll(".promote-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const item = e.target.closest(".top-q-item");
      const question = item.dataset.question;
      const res = await fetch("/api/admin/reporting/most-common-questions/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Questions asked before Limona started saving answer text (see
        // migration 0014) have nothing to promote from automatically —
        // fall back to letting the admin write the answer once, instead of
        // just failing.
        if (body.needsManualAnswer) {
          openManualPromoteForm(item, question);
          return;
        }
        showError(body.error || "Failed to save this as a Team Knowledge entry.");
        return;
      }
      await loadMostCommonQuestions();
    });
  });
}

function openManualPromoteForm(item, question) {
  const promoteEl = item.querySelector(".top-q-promote");
  promoteEl.innerHTML = `
    <div class="top-q-manual-promote">
      <span class="muted">No saved answer from an earlier ask — write the answer to lock in:</span>
      <textarea class="top-q-manual-answer-input" rows="3" placeholder="Write the answer staff should get…"></textarea>
      <div>
        <button class="secondary save-manual-promote-btn">Save Answer</button>
        <button class="cancel-manual-promote-btn">Cancel</button>
      </div>
    </div>
  `;

  promoteEl.querySelector(".cancel-manual-promote-btn").addEventListener("click", () => loadMostCommonQuestions());

  promoteEl.querySelector(".save-manual-promote-btn").addEventListener("click", async () => {
    const answer = promoteEl.querySelector(".top-q-manual-answer-input").value.trim();
    if (!answer) {
      showError("An answer is required.");
      return;
    }
    const res = await fetch("/api/admin/reporting/most-common-questions/promote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, answer }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showError(body.error || "Failed to save this as a Team Knowledge entry.");
      return;
    }
    await loadMostCommonQuestions();
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
        <td data-label="Question">${escapeHtml(q.question)}</td>
        <td data-label="Answered"><span class="badge ${q.answered ? "badge-ready" : "badge-failed"}">${q.answered ? "Yes" : "No"}</span></td>
        <td data-label="Asked by">${escapeHtml(q.asked_by || "Unknown")}</td>
        <td data-label="When">${new Date(q.created_at).toLocaleString()}</td>
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
