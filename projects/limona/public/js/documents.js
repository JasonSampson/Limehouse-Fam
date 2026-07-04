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

  renderSidebar({ activePage: "/documents.html", user: me.user });

  await loadCategories();
  await loadDocuments();
}

let categoriesCache = [];

async function loadCategories() {
  const res = await fetch("/api/admin/categories");
  const body = await res.json();
  categoriesCache = body.categories;

  const filterSelect = document.getElementById("filter-category");
  filterSelect.innerHTML =
    `<option value="">All categories</option>` +
    categoriesCache.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
}

document.getElementById("filter-category").addEventListener("change", loadDocuments);

async function loadDocuments() {
  const categoryId = document.getElementById("filter-category").value;
  const url = categoryId ? `/api/admin/documents?categoryId=${categoryId}` : "/api/admin/documents";
  const res = await fetch(url);
  const body = await res.json();

  const tbody = document.getElementById("documents-body");
  tbody.innerHTML = body.documents
    .map((d) => {
      const badgeClass =
        d.status === "ready" ? "badge-ready" : d.status === "processing" ? "badge-processing" : "badge-failed";
      const categorySelect = categoriesCache
        .map((c) => `<option value="${c.id}" ${c.id === d.category_id ? "selected" : ""}>${c.name}</option>`)
        .join("");
      return `
        <tr data-id="${d.id}">
          <td>${d.filename}</td>
          <td><select class="recategorize-select">${categorySelect}</select></td>
          <td><span class="badge ${badgeClass}">${d.status}</span></td>
          <td>v${d.version}</td>
          <td>${new Date(d.created_at).toLocaleDateString()}</td>
          <td>
            <button class="secondary download-btn">Download original</button>
            <button class="danger remove-btn">Remove</button>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("tr").forEach((row) => {
    const id = row.dataset.id;
    row.querySelector(".recategorize-select").addEventListener("change", async (e) => {
      const res = await fetch(`/api/admin/documents/${id}/category`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId: Number(e.target.value) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showError(body.error || "Failed to re-categorize.");
      }
    });
    row.querySelector(".download-btn").addEventListener("click", () => {
      window.location.href = `/api/admin/documents/${id}/download`;
    });
    row.querySelector(".remove-btn").addEventListener("click", async () => {
      if (!confirm("Remove this document? It will stop appearing in chat answers, but the file is kept on disk.")) return;
      const res = await fetch(`/api/admin/documents/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showError(body.error || "Failed to remove document.");
        return;
      }
      loadDocuments();
    });
  });
}

init();
