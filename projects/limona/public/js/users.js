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

  renderSidebar({ activePage: "/users.html", user: me.user });

  await loadUsers();
}

async function loadUsers() {
  const res = await fetch("/api/admin/users");
  const body = await res.json();
  const tbody = document.getElementById("users-body");
  tbody.innerHTML = body.users
    .map(
      (u) => `
      <tr data-id="${u.id}">
        <td>${u.name}</td>
        <td>${u.email}</td>
        <td>${u.role}</td>
        <td>${u.status}</td>
        <td>${u.role !== "admin" && u.status !== "disabled" ? '<button class="danger disable-btn">Disable</button>' : ""}</td>
      </tr>
    `
    )
    .join("");

  tbody.querySelectorAll(".disable-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.closest("tr").dataset.id;
      if (!confirm("Disable this user's access? Their history is kept, but they will not be able to log in.")) return;
      const res = await fetch(`/api/admin/users/${id}/disable`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        showError(body.error || "Failed to disable user.");
        return;
      }
      loadUsers();
    });
  });
}

document.getElementById("invite-button").addEventListener("click", async () => {
  const email = document.getElementById("invite-email").value;
  const name = document.getElementById("invite-name").value;
  const resultEl = document.getElementById("invite-result");

  if (!email || !name) {
    showError("Email and name are required to invite someone.");
    return;
  }

  const res = await fetch("/api/admin/users/invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  const body = await res.json();
  if (!res.ok) {
    showError(body.error || "Failed to invite user.");
    return;
  }

  const inviteUrl = `${window.location.origin}/accept-invite.html?token=${body.inviteToken}`;
  resultEl.innerHTML = `Invite created. Send this link to ${name}:<br><code>${inviteUrl}</code>`;
  document.getElementById("invite-email").value = "";
  document.getElementById("invite-name").value = "";
  await loadUsers();
});

init();
