// Admin-only page (gated server-side, same as team-performance.html/
// ceo-view.html) — a table of every invited staff account plus a two-field
// "Add Staff" form (email + role; display name/last login fill in
// themselves once that person actually signs in via Microsoft).

let staffList = [];

document.addEventListener("DOMContentLoaded", () => {
  renderHeader("manage-staff");
  loadStaff();
});

async function loadStaff() {
  const content = document.getElementById("page-content");
  content.innerHTML = `<p class="loading-text">Loading…</p>`;
  try {
    staffList = await apiGet("/api/staff-users");
    render();
  } catch (err) {
    content.innerHTML = errorBanner(`Couldn't load staff list: ${err.message}`);
  }
}

function render() {
  const content = document.getElementById("page-content");
  content.innerHTML = `
    <div class="section">
      <p class="section-title">Add Staff</p>
      <form id="invite-form" class="invite-form">
        <input type="email" id="invite-email" placeholder="name@limehousepm.com" required />
        <select id="invite-role">
          <option value="staff">Staff</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit">Add</button>
      </form>
      <p class="password-error" id="invite-error"></p>
    </div>

    <div class="section">
      <p class="section-title">Staff (${staffList.length})</p>
      <table class="kpi-table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Active</th>
            <th>Last Login</th>
          </tr>
        </thead>
        <tbody>
          ${staffList.map(rowHtml).join("")}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById("invite-form").addEventListener("submit", onInviteSubmit);
  staffList.forEach((s) => {
    document.getElementById(`role-${s.id}`).addEventListener("change", (e) => onUpdate(s.id, { role: e.target.value }));
    document
      .getElementById(`active-${s.id}`)
      .addEventListener("change", (e) => onUpdate(s.id, { active: e.target.checked }));
  });
}

function rowHtml(s) {
  return `
    <tr>
      <td>${s.displayName ? `${s.displayName}<br><span class="tile-sub">${s.email}</span>` : s.email}</td>
      <td>
        <select id="role-${s.id}">
          <option value="staff" ${s.role === "staff" ? "selected" : ""}>Staff</option>
          <option value="admin" ${s.role === "admin" ? "selected" : ""}>Admin</option>
        </select>
      </td>
      <td><input type="checkbox" id="active-${s.id}" ${s.active ? "checked" : ""} /></td>
      <td>${formatDateTime(s.lastLoginAt)}</td>
    </tr>
  `;
}

async function onInviteSubmit(e) {
  e.preventDefault();
  const email = document.getElementById("invite-email").value.trim();
  const role = document.getElementById("invite-role").value;
  const errorEl = document.getElementById("invite-error");
  errorEl.textContent = "";
  try {
    await apiPost("/api/staff-users", { email, role });
    await loadStaff();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

async function onUpdate(id, patch) {
  try {
    const res = await fetch(`/api/staff-users/${id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error("Update failed.");
    await loadStaff();
  } catch (err) {
    alert(`Couldn't update staff member: ${err.message}`);
    await loadStaff();
  }
}
