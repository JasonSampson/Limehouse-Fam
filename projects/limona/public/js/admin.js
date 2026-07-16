const errorEl = document.getElementById("error");

function showError(message) {
  errorEl.textContent = message;
  errorEl.style.display = "block";
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

let categoriesCache = [];

async function loadCategories() {
  const res = await fetch("/api/admin/categories");
  const body = await res.json();
  categoriesCache = body.categories;

  const uploadSelect = document.getElementById("upload-category");
  uploadSelect.innerHTML = categoriesCache.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
}

document.getElementById("upload-button").addEventListener("click", async () => {
  const categoryId = document.getElementById("upload-category").value;
  const files = document.getElementById("upload-files").files;
  const statusEl = document.getElementById("upload-status");

  if (files.length === 0) {
    showError("Select at least one file to upload.");
    return;
  }

  statusEl.textContent = `Uploading ${files.length} file(s)...`;

  try {
    if (files.length === 1) {
      const formData = new FormData();
      formData.append("file", files[0]);
      formData.append("categoryId", categoryId);
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
      formData.append("categoryId", categoryId);
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
    statusEl.innerHTML += `<a href="/documents.html">View in Document Library</a>`;
  } catch (err) {
    showError("Upload failed: " + err.message);
    statusEl.textContent = "";
  }
});

init();
