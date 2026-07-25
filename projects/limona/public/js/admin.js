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

  renderSidebar({ activePage: "/admin.html", user: me.user });

  await loadCategories();
}

const uploadDropzone = initDropzone({
  dropzoneId: "upload-dropzone",
  inputId: "upload-files",
  filenamesId: "upload-dropzone-filenames",
});

// Categories are free-form text now (see adminDocumentRoutes.ts) — the
// category field here is a text input with autocomplete off the live
// in-use category list, not a fixed dropdown.
let categoriesCache = [];

async function loadCategories() {
  const res = await fetch("/api/admin/categories");
  const body = await res.json();
  categoriesCache = body.categories;

  const datalist = document.getElementById("category-datalist");
  datalist.innerHTML = categoriesCache.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
}

document.getElementById("upload-button").addEventListener("click", async () => {
  let category = document.getElementById("upload-category").value.trim();
  const description = document.getElementById("upload-description").value.trim();
  const documentCreatedAt = document.getElementById("upload-doc-created-at").value || "";
  const files = document.getElementById("upload-files").files;
  const statusEl = document.getElementById("upload-status");

  if (files.length === 0) {
    showError("Select at least one file to upload.");
    return;
  }
  if (!category) {
    showError("A category is required.");
    return;
  }
  if (!description) {
    showError("A description is required.");
    return;
  }

  // "Laws" is a special category: Limona always treats it as general legal
  // reference material and prioritizes company policy documents over it
  // when answering (see generateAnswer.ts). A confirmation here catches an
  // accidental miscategorization before it can quietly change how Limona
  // answers questions.
  const normalizedCategory = category.trim().toLowerCase();
  if (normalizedCategory === "laws" || normalizedCategory === "law") {
    const confirmed = confirm(
      'You\'re uploading this as a "Laws" document. Limona always treats this category as general legal reference material (like a state or federal law) and will prefer your company\'s own policies over it when both are relevant.\n\nOnly continue if this really is a law or legal-reference document — not a Limehouse policy, lease, or SOP.'
    );
    if (!confirmed) return;
    // Normalize to the canonical "Laws" spelling/casing so this actually
    // joins the real category (and gets the safeguard above) instead of
    // silently creating a near-duplicate category that doesn't.
    category = "Laws";
  }

  statusEl.textContent = `Uploading ${files.length} file(s)...`;

  try {
    if (files.length === 1) {
      const formData = new FormData();
      formData.append("file", files[0]);
      formData.append("category", category);
      formData.append("description", description);
      formData.append("documentCreatedAt", documentCreatedAt);
      const res = await fetch("/api/admin/documents/upload", { method: "POST", body: formData });
      const body = await res.json();
      if (!res.ok) {
        showError(body.error || "Upload failed.");
        statusEl.textContent = "";
        return;
      }
      statusEl.textContent = `Uploaded — status: ${body.status}. `;
    } else {
      const formData = new FormData();
      for (const file of files) formData.append("files", file);
      formData.append("category", category);
      formData.append("description", description);
      formData.append("documentCreatedAt", documentCreatedAt);
      const res = await fetch("/api/admin/documents/bulk-upload", { method: "POST", body: formData });
      const body = await res.json();
      if (!res.ok) {
        showError(body.error || "Bulk upload failed.");
        statusEl.textContent = "";
        return;
      }
      const succeeded = body.results.filter((r) => r.status === "ready").length;
      const failed = body.results.filter((r) => r.status === "failed").length;
      statusEl.textContent = `Done: ${succeeded} ready, ${failed} failed. `;
    }
    document.getElementById("upload-files").value = "";
    uploadDropzone.updateFilenames();
    statusEl.innerHTML += `<a href="/documents.html">View in Document Library</a>`;
    await loadCategories();
  } catch (err) {
    showError("Upload failed: " + err.message);
    statusEl.textContent = "";
  }
});

init();
