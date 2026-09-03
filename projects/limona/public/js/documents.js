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
  // CHANGED [today], per Jason directly: Document Library is open to any
  // signed-in Limona user now — the old redirect-to-chat gate here required
  // limona.documents.manage just to BROWSE. canManage still controls
  // whether the edit-in-place cells and Remove button render at all (see
  // render()/renderCategorySection() below); the backend independently
  // rejects those actions for anyone without the permission regardless.
  window.canManageDocuments = me.user.permissions.includes("limona.documents.manage");
  const uploadLink = document.getElementById("upload-new-link");
  if (uploadLink && !window.canManageDocuments) uploadLink.style.display = "none";

  renderSidebar({ activePage: "/documents.html", user: me.user });

  await loadCategories();
  await loadDocuments();
}

// categoriesCache is now a flat list of in-use category strings (free text,
// not a fixed lookup table — see adminDocumentRoutes.ts) used to populate
// the shared <datalist> that both the recategorize inline editor here and
// the upload page's category field autocomplete against.
let categoriesCache = [];

async function loadCategories() {
  const res = await fetch("/api/admin/categories");
  const body = await res.json();
  categoriesCache = body.categories;

  const datalist = document.getElementById("category-datalist");
  if (datalist) {
    datalist.innerHTML = categoriesCache.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
  }
}

async function loadDocuments() {
  const res = await fetch("/api/admin/documents");
  const body = await res.json();
  render(body.documents);
}

// Vendor's layout: one section per category (with a document count badge),
// each containing its own small table — not one flat table with a filter
// dropdown. Categories are grouped directly off each document's own
// `category` string (free text now, not a categoryId), sorted alphabetically,
// so a section always exists for exactly the categories actually in use.
function render(documents) {
  const byCategory = new Map();
  for (const doc of documents) {
    if (!byCategory.has(doc.category)) byCategory.set(doc.category, []);
    byCategory.get(doc.category).push(doc);
  }

  const categoryNames = [...byCategory.keys()].sort((a, b) => a.localeCompare(b));

  const container = document.getElementById("documents-container");
  container.innerHTML = categoryNames.map((name) => renderCategorySection(name, byCategory.get(name))).join("");

  categoryNames.forEach((name) => {
    byCategory.get(name).forEach((d) => attachRowHandlers(d));
  });
}

function renderCategorySection(categoryName, docs) {
  const rows = docs
    .map(
      (d) => `
        <tr data-id="${d.id}">
          <td data-label="Document"><a href="/api/admin/documents/${d.id}/preview" target="_blank" class="doc-name-link" title="${escapeHtml(d.filename)}">${escapeHtml(d.filename)}</a></td>
          <td class="doc-description-cell" data-label="Description">${renderDescriptionDisplay(d)}</td>
          <td class="doc-created-cell" data-label="Doc Created">${renderDocCreatedDisplay(d)}</td>
          <td data-label="Uploaded">${new Date(d.created_at).toLocaleDateString()}</td>
          <td class="doc-category-cell" data-label="Category">${renderCategoryDisplay(d)}</td>
          <td class="actions-cell">
            <button class="secondary download-btn">Download</button>
            ${window.canManageDocuments ? `<button class="danger remove-btn">Remove</button>` : ""}
          </td>
        </tr>
      `
    )
    .join("");

  const docWord = docs.length === 1 ? "document" : "documents";

  return `
    <div class="card category-section">
      <div class="category-section-header">
        <h2 class="category-section-title">${escapeHtml(categoryName)}</h2>
        <span class="badge category-count-badge">${docs.length} ${docWord}</span>
      </div>
      <table>
        <thead>
          <tr><th>Document</th><th>Description</th><th>Doc Created</th><th>Uploaded</th><th>Category</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderCategoryDisplay(doc) {
  return `<span class="category-value">${escapeHtml(doc.category)}</span>`;
}

function renderDescriptionDisplay(doc) {
  return `<span class="description-value">${doc.description ? escapeHtml(doc.description) : "—"}</span>`;
}

function formatDocCreatedDate(value) {
  if (!value) return null;
  // document_created_at may come back as a plain "YYYY-MM-DD" string or a
  // full ISO timestamp (e.g. if pg parses the DATE column into a JS Date
  // that then serializes with a time/zone) — always take just the date part
  // and construct it at local midnight so the displayed day never shifts
  // due to timezone conversion.
  const datePart = String(value).slice(0, 10);
  return new Date(`${datePart}T00:00:00`).toLocaleDateString();
}

function renderDocCreatedDisplay(doc) {
  const formatted = formatDocCreatedDate(doc.document_created_at);
  return `<span class="doc-created-value">${formatted || "—"}</span>`;
}

// Description, Doc Created, and Category all share one interaction: click
// the displayed value in place, it swaps for an editable control, and it
// saves and reverts to display automatically (no separate "edit" button for
// any of them). Category still autocompletes off the live in-use category
// list; committing a new category saves it and the whole list re-renders so
// the row moves to its new section.
function attachRowHandlers(doc) {
  const id = doc.id;
  const row = document.querySelector(`tr[data-id="${id}"]`);
  if (!row) return;

  row.querySelector(".download-btn").addEventListener("click", () => {
    window.location.href = `/api/admin/documents/${id}/download`;
  });

  // View-only users (no limona.documents.manage) get a read-only row: no
  // click-to-edit cells, no Remove button (not rendered at all — see
  // renderCategorySection). The backend independently rejects these
  // actions regardless, but hiding them avoids a confusing "click, edit,
  // then get a permission error" dead end.
  if (!window.canManageDocuments) return;

  attachDescriptionHandler(row.querySelector(".doc-description-cell"), doc);
  attachDocCreatedHandler(row.querySelector(".doc-created-cell"), doc);
  attachCategoryHandler(row.querySelector(".doc-category-cell"), doc);

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
}

function attachCategoryHandler(cell, doc) {
  cell.addEventListener("click", () => {
    // Ignore clicks that land on an already-open input.
    if (cell.querySelector("input")) return;
    openCategoryPicker(cell, doc);
  });
}

function openCategoryPicker(cell, doc) {
  const current = doc.category;
  cell.innerHTML = `<input type="text" class="recategorize-input" list="category-datalist" value="${escapeHtml(current)}">`;
  const input = cell.querySelector("input");
  input.focus();
  input.select();

  let settled = false;

  function revert() {
    cell.innerHTML = renderCategoryDisplay(doc);
  }

  async function commit() {
    if (settled) return;
    settled = true;
    let newCategory = input.value.trim();
    if (!newCategory || newCategory === current) {
      revert();
      return;
    }

    // Same safeguard as the upload page (admin.js): "Laws" gets special
    // treatment in generateAnswer.ts (deprioritized vs. company policy), so
    // recategorizing a document into it — or a near-miss spelling that
    // would silently create a duplicate, uncaught category — needs the
    // same confirm-and-normalize step here too.
    const normalized = newCategory.toLowerCase();
    if (normalized === "laws" || normalized === "law") {
      const confirmed = confirm(
        'You\'re changing this document\'s category to "Laws". Limona always treats this category as general legal reference material (like a state or federal law) and will prefer your company\'s own policies over it when both are relevant.\n\nOnly continue if this really is a law or legal-reference document — not a Limehouse policy, lease, or SOP.'
      );
      if (!confirmed) {
        revert();
        return;
      }
      newCategory = "Laws";
    }

    const res = await fetch(`/api/admin/documents/${doc.id}/category`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: newCategory }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showError(body.error || "Failed to re-categorize.");
      revert();
      return;
    }
    // Simplest correct approach: reload everything (documents + the in-use
    // category list) so the row moves into its new category's section and
    // the datalist picks up any brand-new category the admin just typed.
    await loadCategories();
    loadDocuments();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      settled = true;
      revert();
    }
  });
  input.addEventListener("blur", commit);
}

function attachDocCreatedHandler(cell, doc) {
  cell.addEventListener("click", () => {
    // Ignore clicks that land on an already-open date input.
    if (cell.querySelector("input")) return;
    openDocCreatedEditor(cell, doc);
  });
}

function openDocCreatedEditor(cell, doc) {
  const current = doc.document_created_at ? doc.document_created_at.slice(0, 10) : "";
  cell.innerHTML = `<input type="date" class="doc-created-input" value="${current}">`;
  const input = cell.querySelector("input");
  input.focus();

  let settled = false;

  function revert() {
    cell.innerHTML = renderDocCreatedDisplay(doc);
  }

  async function commit() {
    if (settled) return;
    settled = true;
    const newValue = input.value || null;
    const res = await fetch(`/api/admin/documents/${doc.id}/document-created-at`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentCreatedAt: newValue }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showError(body.error || "Failed to update Doc Created date.");
      revert();
      return;
    }
    loadDocuments();
  }

  input.addEventListener("change", commit);
  input.addEventListener("blur", () => {
    if (!settled) revert();
  });
}

function attachDescriptionHandler(cell, doc) {
  cell.addEventListener("click", () => {
    // Ignore clicks that land on an already-open input.
    if (cell.querySelector("input")) return;
    openDescriptionEditor(cell, doc);
  });
}

function openDescriptionEditor(cell, doc) {
  const current = doc.description || "";
  cell.innerHTML = `<input type="text" class="description-input" value="${escapeHtml(current)}">`;
  const input = cell.querySelector("input");
  input.focus();
  input.select();

  let settled = false;

  function revert() {
    cell.innerHTML = renderDescriptionDisplay(doc);
  }

  async function commit() {
    if (settled) return;
    settled = true;
    const newValue = input.value.trim();
    if (newValue === current) {
      revert();
      return;
    }
    const res = await fetch(`/api/admin/documents/${doc.id}/description`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: newValue }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showError(body.error || "Failed to update description.");
      revert();
      return;
    }
    loadDocuments();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      settled = true;
      revert();
    }
  });
  input.addEventListener("blur", commit);
}

init();
