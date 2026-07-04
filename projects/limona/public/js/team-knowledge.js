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

  renderSidebar({ activePage: "/team-knowledge.html", user: me.user });

  await loadEntries();
}

async function loadEntries() {
  const res = await fetch("/api/admin/team-knowledge");
  const body = await res.json();

  const tbody = document.getElementById("entries-body");
  tbody.innerHTML = body.entries
    .map(
      (e) => `
      <tr data-id="${e.id}">
        <td>${e.question}</td>
        <td>${e.answer}</td>
        <td>${new Date(e.created_at).toLocaleDateString()}</td>
        <td><button class="danger remove-btn">Delete</button></td>
      </tr>
    `
    )
    .join("");

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
