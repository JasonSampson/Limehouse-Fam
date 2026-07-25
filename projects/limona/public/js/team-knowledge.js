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

  renderSidebar({ activePage: "/team-knowledge.html", user: me.user });

  await loadEntries();
}

// Hampton Roads is Eastern time, so "When" is always shown in America/New_York
// regardless of what timezone the browser/OS is set to.
function formatWhen(value) {
  return new Date(value).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "short",
    timeStyle: "short",
  });
}

function renderRow(e) {
  return `
    <tr data-id="${e.id}">
      <td class="tk-question-cell"><strong>${escapeHtml(e.question)}</strong></td>
      <td class="tk-answer-cell">${escapeHtml(e.answer)}</td>
      <td>${escapeHtml(e.created_by_name || "—")}</td>
      <td>${formatWhen(e.created_at)}</td>
      <td class="actions-cell">
        <button class="secondary edit-btn">Edit</button>
        <button class="danger remove-btn">Delete</button>
      </td>
    </tr>
  `;
}

let entriesCache = [];

async function loadEntries() {
  const res = await fetch("/api/admin/team-knowledge");
  const body = await res.json();
  entriesCache = body.entries;

  const tbody = document.getElementById("entries-body");
  tbody.innerHTML = entriesCache.map(renderRow).join("");

  tbody.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      if (!confirm("Delete this entry? It will stop being used to answer chat questions.")) return;
      const res = await fetch(`/api/admin/team-knowledge/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showError(body.error || "Failed to delete entry.");
        return;
      }
      loadEntries();
    });
  });

  tbody.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const row = e.target.closest("tr");
      const entry = entriesCache.find((en) => en.id === row.dataset.id);
      if (entry) openEditMode(row, entry);
    });
  });
}

function openEditMode(row, entry) {
  const questionCell = row.querySelector(".tk-question-cell");
  const answerCell = row.querySelector(".tk-answer-cell");
  const actionsCell = row.querySelector(".actions-cell");

  questionCell.innerHTML = `<textarea class="tk-edit-question" rows="2">${escapeHtml(entry.question)}</textarea>`;
  answerCell.innerHTML = `<textarea class="tk-edit-answer" rows="8">${escapeHtml(entry.answer)}</textarea>`;
  actionsCell.innerHTML = `<button class="secondary save-btn">Save</button><button class="cancel-btn">Cancel</button>`;

  actionsCell.querySelector(".cancel-btn").addEventListener("click", () => loadEntries());

  actionsCell.querySelector(".save-btn").addEventListener("click", async () => {
    const question = row.querySelector(".tk-edit-question").value.trim();
    const answer = row.querySelector(".tk-edit-answer").value.trim();
    if (!question || !answer) {
      showError("Both a question and an answer are required.");
      return;
    }
    const res = await fetch(`/api/admin/team-knowledge/${entry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, answer }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showError(body.error || "Failed to update this entry.");
      return;
    }
    loadEntries();
  });
}

document.getElementById("add-button").addEventListener("click", async () => {
  const question = document.getElementById("entry-question").value.trim();
  const answer = document.getElementById("entry-answer").value.trim();
  const statusEl = document.getElementById("add-status");

  if (!question || !answer) {
    showError("Both a question and an answer are required.");
    return;
  }

  statusEl.textContent = "Saving...";

  try {
    const res = await fetch("/api/admin/team-knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, answer }),
    });
    const body = await res.json();
    if (!res.ok) {
      showError(body.error || "Failed to save this entry.");
      statusEl.textContent = "";
      return;
    }
    statusEl.textContent = "Saved.";
    document.getElementById("entry-question").value = "";
    document.getElementById("entry-answer").value = "";
    await loadEntries();
  } catch (err) {
    showError("Failed to save: " + err.message);
    statusEl.textContent = "";
  }
});

init();
