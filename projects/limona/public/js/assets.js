const errorEl = document.getElementById("error");

function showError(message) {
  errorEl.textContent = message;
  errorEl.style.display = "block";
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

  await loadAssets();
}

async function loadAssets() {
  const res = await fetch("/api/admin/assets");
  const body = await res.json();

  const tbody = document.getElementById("assets-body");
  tbody.innerHTML = body.assets
    .map(
      (a) => `
      <tr data-id="${a.id}">
        <td>${a.filename}</td>
        <td>${a.description}</td>
        <td>${a.category}</td>
        <td>${formatBytes(a.size_bytes)}</td>
        <td>${new Date(a.created_at).toLocaleDateString()}</td>
        <td>
          <button class="secondary download-btn">Download</button>
          <button class="danger remove-btn">Delete</button>
        </td>
      </tr>
    `
    )
    .join("");

  tbody.querySelectorAll("tr").forEach((row) => {
    const id = row.dataset.id;
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
  });
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
    await loadAssets();
  } catch (err) {
    showError("Upload failed: " + err.message);
    statusEl.textContent = "";
  }
});

init();
