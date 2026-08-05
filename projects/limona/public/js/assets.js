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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

  renderSidebar({ activePage: "/assets.html", user: me.user });

  await loadAssetCategories();
  await loadAssets();
}

const uploadDropzone = initDropzone({
  dropzoneId: "upload-dropzone",
  inputId: "upload-file",
  filenamesId: "upload-dropzone-filenames",
});

// assetCategoriesCache is a flat list of in-use category strings pulled from
// Assets' own /api/admin/asset-categories endpoint — deliberately separate
// from Document Library's category list (see adminAssetRoutes.ts), so the
// inline re-categorize editor below only ever suggests categories assets
// actually use.
let assetCategoriesCache = [];

async function loadAssetCategories() {
  const res = await fetch("/api/admin/asset-categories");
  const body = await res.json();
  assetCategoriesCache = body.categories;

  const datalist = document.getElementById("asset-category-datalist");
  if (datalist) {
    datalist.innerHTML = assetCategoriesCache.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
  }
}

async function loadAssets() {
  const res = await fetch("/api/admin/assets");
  const body = await res.json();
  render(body.assets);
}

// Same layout as Document Library: one card per category (with an asset
// count badge), each containing its own small table, rather than one flat
// table. Categories are grouped directly off each asset's own `category`
// string, sorted alphabetically, so a section always exists for exactly the
// categories actually in use.
function render(assets) {
  const byCategory = new Map();
  for (const asset of assets) {
    if (!byCategory.has(asset.category)) byCategory.set(asset.category, []);
    byCategory.get(asset.category).push(asset);
  }

  const categoryNames = [...byCategory.keys()].sort((a, b) => a.localeCompare(b));

  const container = document.getElementById("assets-container");
  container.innerHTML = categoryNames.map((name) => renderCategorySection(name, byCategory.get(name))).join("");

  categoryNames.forEach((name) => {
    byCategory.get(name).forEach((a) => attachRowHandlers(a));
  });
}

function renderCategorySection(categoryName, assets) {
  const rows = assets
    .map(
      (a) => `
        <tr data-id="${a.id}">
          <td data-label="Document"><a href="/api/admin/assets/${a.id}/preview" target="_blank" class="doc-name-link" title="${escapeHtml(a.filename)}">${escapeHtml(a.filename)}</a></td>
          <td class="doc-description-cell" data-label="Description">${renderDescriptionDisplay(a)}</td>
          <td class="doc-category-cell" data-label="Category">${renderCategoryDisplay(a)}</td>
          <td data-label="Size">${formatBytes(a.size_bytes)}</td>
          <td data-label="Uploaded">${new Date(a.created_at).toLocaleDateString()}</td>
          <td class="actions-cell">
            <button class="secondary download-btn">Download</button>
            <button class="danger remove-btn">Remove</button>
          </td>
        </tr>
      `
    )
    .join("");

  const assetWord = assets.length === 1 ? "asset" : "assets";

  return `
    <div class="card category-section">
      <div class="category-section-header">
        <h2 class="category-section-title">${escapeHtml(categoryName)}</h2>
        <span class="badge category-count-badge">${assets.length} ${assetWord}</span>
      </div>
      <table>
        <thead>
          <tr><th>Document</th><th>Description</th><th>Category</th><th>Size</th><th>Uploaded</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderCategoryDisplay(asset) {
  return `<span class="category-value">${escapeHtml(asset.category)}</span>`;
}

function renderDescriptionDisplay(asset) {
  return `<span class="description-value">${asset.description ? escapeHtml(asset.description) : "—"}</span>`;
}

// Description and Category both share one interaction: click the displayed
// value in place, it swaps for an editable control, and it saves and reverts
// to display automatically (no separate "edit" button for either). Category
// still autocompletes off the live in-use asset category list; committing a
// new category saves it and the whole list re-renders so the row moves to
// its new section.
function attachRowHandlers(asset) {
  const id = asset.id;
  const row = document.querySelector(`tr[data-id="${id}"]`);
  if (!row) return;

  attachDescriptionHandler(row.querySelector(".doc-description-cell"), asset);
  attachCategoryHandler(row.querySelector(".doc-category-cell"), asset);

  row.querySelector(".download-btn").addEventListener("click", () => {
    window.location.href = `/api/admin/assets/${id}/download`;
  });
  row.querySelector(".remove-btn").addEventListener("click", async () => {
    if (!confirm("Delete this asset? This cannot be undone.")) return;
    const res = await fetch(`/api/admin/assets/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showError(body.error || "Failed to delete asset.");
      return;
    }
    loadAssets();
  });
}

function attachCategoryHandler(cell, asset) {
  cell.addEventListener("click", () => {
    // Ignore clicks that land on an already-open input.
    if (cell.querySelector("input")) return;
    openCategoryPicker(cell, asset);
  });
}

function openCategoryPicker(cell, asset) {
  const current = asset.category;
  cell.innerHTML = `<input type="text" class="recategorize-input" list="asset-category-datalist" value="${escapeHtml(current)}">`;
  const input = cell.querySelector("input");
  input.focus();
  input.select();

  let settled = false;

  function revert() {
    cell.innerHTML = renderCategoryDisplay(asset);
  }

  async function commit() {
    if (settled) return;
    settled = true;
    const newCategory = input.value.trim();
    if (!newCategory || newCategory === current) {
      revert();
      return;
    }
    const res = await fetch(`/api/admin/assets/${asset.id}/category`, {
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
    // Simplest correct approach: reload everything (assets + the in-use
    // category list) so the row moves into its new category's section and
    // the datalist picks up any brand-new category the admin just typed.
    await loadAssetCategories();
    loadAssets();
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

function attachDescriptionHandler(cell, asset) {
  cell.addEventListener("click", () => {
    // Ignore clicks that land on an already-open input.
    if (cell.querySelector("input")) return;
    openDescriptionEditor(cell, asset);
  });
}

function openDescriptionEditor(cell, asset) {
  const current = asset.description || "";
  cell.innerHTML = `<input type="text" class="description-input" value="${escapeHtml(current)}">`;
  const input = cell.querySelector("input");
  input.focus();
  input.select();

  let settled = false;

  function revert() {
    cell.innerHTML = renderDescriptionDisplay(asset);
  }

  async function commit() {
    if (settled) return;
    settled = true;
    const newValue = input.value.trim();
    if (newValue === current) {
      revert();
      return;
    }
    const res = await fetch(`/api/admin/assets/${asset.id}/description`, {
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
    loadAssets();
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

document.getElementById("upload-button").addEventListener("click", async () => {
  const description = document.getElementById("upload-description").value.trim();
  const category = document.getElementById("upload-category").value.trim();
  const fileInput = document.getElementById("upload-file");
  const statusEl = document.getElementById("upload-status");

  if (!fileInput.files.length) {
    showError("Select a file to upload.");
    return;
  }
  if (!description || !category) {
    showError("Description and category are required.");
    return;
  }

  statusEl.textContent = "Uploading...";

  try {
    const formData = new FormData();
    formData.append("file", fileInput.files[0]);
    formData.append("description", description);
    formData.append("category", category);
    const res = await fetch("/api/admin/assets/upload", { method: "POST", body: formData });
    const body = await res.json();
    if (!res.ok) {
      showError(body.error || "Upload failed.");
      statusEl.textContent = "";
      return;
    }
    statusEl.textContent = "Uploaded.";
    document.getElementById("upload-description").value = "";
    document.getElementById("upload-category").value = "";
    fileInput.value = "";
    uploadDropzone.updateFilenames();
    await loadAssetCategories();
    await loadAssets();
  } catch (err) {
    showError("Upload failed: " + err.message);
    statusEl.textContent = "";
  }
});

init();
