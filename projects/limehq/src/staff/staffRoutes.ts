import crypto from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import { getAppPool } from "../db/pool.js";
import { hashPassword, validatePasswordStrength } from "../auth/password.js";
import { hasPermission, getPermissionBreakdown, type PermissionBreakdown } from "../auth/permissions.js";
import { requireSession } from "../auth/requireSession.js";
import { ApiError } from "../lib/apiError.js";
import { writeAuditLog } from "../lib/auditLog.js";

const router = Router();

router.use(express.urlencoded({ extended: false }));
router.use(requireSession);

// ------------------------------------------------------------------ //
// Utilities                                                           //
// ------------------------------------------------------------------ //

/** Escape a value for safe insertion into HTML. */
function esc(val: string | number | null | undefined): string {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Fetch display_name for the currently logged-in user. */
async function getDisplayName(userId: number): Promise<string> {
  const pool = getAppPool();
  const result = await pool.query<{ display_name: string }>(
    `SELECT display_name FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0]?.display_name ?? "Unknown";
}

/** Same "never" / short-date convention the old dashboard Manage Staff page used. */
function formatLastLogin(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// ------------------------------------------------------------------ //
// HTML Layout                                                         //
// ------------------------------------------------------------------ //

const SHARED_CSS = `
  @font-face {
    font-family: 'Quicksand';
    src: url('/fonts/Quicksand-Regular.ttf') format('truetype');
    font-weight: 400; font-style: normal;
  }
  @font-face {
    font-family: 'Quicksand';
    src: url('/fonts/Quicksand-Medium.ttf') format('truetype');
    font-weight: 500; font-style: normal;
  }
  @font-face {
    font-family: 'Quicksand';
    src: url('/fonts/Quicksand-Bold.ttf') format('truetype');
    font-weight: 700; font-style: normal;
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Quicksand', system-ui, sans-serif;
    background: #f0f4f0;
    min-height: 100vh;
    color: #222;
  }

  /* ── Nav bar ────────────────────────────────────────────────────── */
  .nav {
    background: #fff;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    padding: 0.75rem 1.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .nav-brand {
    display: inline-flex;
    align-items: center;
    text-decoration: none;
  }
  .nav-brand-logo {
    height: 44px;
    width: auto;
    display: block;
  }

  .nav-right { display: flex; align-items: center; gap: 1rem; }
  .page-tabs {
    display: flex; gap: 0.5rem; padding: 0 2rem; background: #fff;
    border-bottom: 1px solid #e5e5e5;
  }
  .page-tab {
    padding: 0.9rem 0.25rem; margin: 0 0.75rem;
    font-size: 0.9rem; font-weight: 600; color: #666;
    text-decoration: none; border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
  }
  .page-tab:hover { color: #333; }
  .page-tab.active { color: #009344; border-bottom-color: #009344; }
  .user-menu { position: relative; }
  .user-menu-trigger {
    background: none; border: none; font-family: 'Quicksand', sans-serif;
    font-size: .875rem; font-weight: 600; color: #333;
    cursor: pointer; display: flex; align-items: center; gap: .3rem;
    padding: .3rem .5rem; border-radius: 7px;
  }
  .user-menu-trigger:hover { background: #f0f4f0; }
  .user-menu-caret { font-size: .65rem; color: #888; }
  .user-menu-dropdown {
    position: absolute; right: 0; top: calc(100% + .4rem);
    background: #fff; border: 1px solid #e0e8e0; border-radius: 10px;
    box-shadow: 0 4px 20px rgba(0,0,0,.12); min-width: 175px; z-index: 100;
    padding: .3rem; display: none;
  }
  .user-menu-dropdown.open { display: block; }
  .user-menu-item {
    display: block; width: 100%; text-align: left;
    padding: .55rem .875rem; border-radius: 7px;
    font-family: 'Quicksand', sans-serif; font-size: .875rem; font-weight: 600;
    color: #333; text-decoration: none;
    background: none; border: none; cursor: pointer; transition: background .1s;
  }
  .user-menu-item:hover { background: #f0f4f0; color: #333; }
  .user-menu-signout { color: #dc2626; }
  .user-menu-signout:hover { background: #fef2f2; }

  /* ── Page content ───────────────────────────────────────────────── */
  .main {
    padding: 2rem 1.25rem;
    max-width: 960px;
    margin: 0 auto;
  }

  /* ── Card ───────────────────────────────────────────────────────── */
  .card {
    background: #fff;
    border-radius: 14px;
    box-shadow: 0 2px 20px rgba(0,0,0,0.09);
    padding: 2rem;
  }

  /* ── Page header ────────────────────────────────────────────────── */
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
  }
  .page-title {
    font-size: 1.2rem;
    font-weight: 700;
    color: #222;
  }

  /* ── Buttons ────────────────────────────────────────────────────── */
  .btn-primary {
    display: inline-block;
    padding: 0.55rem 1.1rem;
    background: #74b62e;
    color: #fff;
    border: none;
    border-radius: 7px;
    font-family: 'Quicksand', sans-serif;
    font-size: 0.9rem;
    font-weight: 700;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-primary:hover { background: #67a228; }

  .btn-secondary {
    display: inline-block;
    padding: 0.5rem 1rem;
    background: #fff;
    color: #444;
    border: 1.5px solid #ddd;
    border-radius: 7px;
    font-family: 'Quicksand', sans-serif;
    font-size: 0.875rem;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-secondary:hover { background: #f5f5f5; }

  /* ── Staff table ────────────────────────────────────────────────── */
  .staff-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  .staff-table th {
    text-align: left;
    font-weight: 600;
    color: #555;
    padding: 0.6rem 0.75rem;
    border-bottom: 2px solid #eee;
  }
  .staff-table td {
    padding: 0.75rem 0.75rem;
    border-bottom: 1px solid #eee;
    color: #333;
    vertical-align: middle;
  }
  .staff-table tr:last-child td { border-bottom: none; }
  .staff-table tr:hover td { background: #fafafa; }

  /* ── Badges ─────────────────────────────────────────────────────── */
  .badge {
    display: inline-block;
    padding: 0.2rem 0.6rem;
    border-radius: 999px;
    font-size: 0.73rem;
    font-weight: 700;
    letter-spacing: 0.3px;
    white-space: nowrap;
  }
  .badge-active   { background: #74b62e; color: #fff; }
  .badge-inactive { background: #aaa;    color: #fff; }
  .badge-owner    { background: #009344; color: #fff; }

  /* ── Form ───────────────────────────────────────────────────────── */
  .form-group { margin-bottom: 1.1rem; }
  .form-group label {
    display: block;
    font-size: 0.875rem;
    font-weight: 600;
    color: #444;
    margin-bottom: 0.3rem;
  }
  .form-group input[type="text"],
  .form-group input[type="email"],
  .form-group input[type="password"],
  .form-group select {
    width: 100%;
    padding: 0.6rem 0.875rem;
    border: 1.5px solid #ddd;
    border-radius: 7px;
    font-family: 'Quicksand', sans-serif;
    font-size: 1rem;
    color: #222;
    transition: border-color 0.15s, box-shadow 0.15s;
    background: #fff;
  }
  .form-group input:focus,
  .form-group select:focus {
    outline: none;
    border-color: #74b62e;
    box-shadow: 0 0 0 3px rgba(116,182,46,0.15);
  }
  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0;
  }
  .checkbox-row input[type="checkbox"] {
    width: 1.1rem;
    height: 1.1rem;
    accent-color: #74b62e;
    cursor: pointer;
  }
  .checkbox-row label {
    font-size: 0.9rem;
    font-weight: 600;
    color: #444;
    cursor: pointer;
    margin: 0;
  }
  .form-actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 1.75rem;
    align-items: center;
  }

  /* ── Banners ────────────────────────────────────────────────────── */
  .success-banner {
    background: #f0fdf4;
    border: 1px solid #86efac;
    color: #166534;
    border-radius: 7px;
    padding: 0.75rem 1rem;
    margin-bottom: 1.25rem;
    font-weight: 600;
    font-size: 0.875rem;
  }

  /* ── Error message ──────────────────────────────────────────────── */
  .error-banner {
    background: #fef2f2;
    border: 1px solid #fca5a5;
    border-radius: 7px;
    padding: 0.75rem 1rem;
    margin-bottom: 1.25rem;
    color: #dc2626;
    font-size: 0.875rem;
    font-weight: 600;
  }

  /* ── Permissions page ───────────────────────────────────────────── */
  .person-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1.5rem;
    padding-bottom: 1.25rem;
    border-bottom: 1px solid #eee;
    flex-wrap: wrap;
  }
  .back-link {
    font-size: 0.875rem;
    font-weight: 600;
    color: #009344;
    text-decoration: none;
    width: 100%;
    margin-bottom: -0.25rem;
  }
  .back-link:hover { text-decoration: underline; }
  .person-avatar {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: #e6f4ec;
    color: #009344;
    font-weight: 700;
    font-size: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .person-info { flex: 1; min-width: 0; }
  .person-name { font-size: 1.05rem; font-weight: 700; color: #222; }
  .person-meta { font-size: 0.85rem; color: #666; margin-top: 0.15rem; }

  .template-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
    flex-wrap: wrap;
  }
  .template-label { font-size: 0.875rem; font-weight: 600; color: #444; white-space: nowrap; }
  .template-bar select {
    padding: 0.45rem 0.75rem;
    border: 1.5px solid #ddd;
    border-radius: 7px;
    font-family: 'Quicksand', sans-serif;
    font-size: 0.9rem;
    color: #222;
    background: #fff;
    flex: 1;
    min-width: 180px;
    max-width: 280px;
  }
  .template-bar select:focus {
    outline: none;
    border-color: #74b62e;
    box-shadow: 0 0 0 3px rgba(116,182,46,0.15);
  }

  .checklist-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }
  .perm-module { }
  .perm-module-name {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #fff;
    background: #009344;
    padding: 0.35rem 0.75rem;
    border-radius: 5px;
    margin-bottom: 0.6rem;
  }
  .perm-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.25rem;
    border-bottom: 1px solid #f5f5f5;
  }
  .perm-row:last-child { border-bottom: none; }
  .perm-row input[type="checkbox"] {
    width: 1.05rem;
    height: 1.05rem;
    accent-color: #74b62e;
    cursor: pointer;
    flex-shrink: 0;
  }
  .perm-row input[type="checkbox"]:disabled { opacity: 0.5; cursor: not-allowed; }
  .perm-row label {
    font-size: 0.875rem;
    color: #333;
    cursor: pointer;
    margin: 0;
    font-weight: 500;
  }
  .perm-source {
    font-size: 0.72rem;
    margin-left: auto;
    padding-left: 0.5rem;
    white-space: nowrap;
  }
  .perm-source-role { color: #999; }
  .perm-source-override { color: #b6742e; font-weight: 600; }
  .save-btn {
    width: auto;
    margin-top: 0;
    padding: 0.6rem 1.75rem;
  }
  .owner-note {
    background: #f0f4f0;
    border-radius: 7px;
    padding: 0.75rem 1rem;
    font-size: 0.9rem;
    color: #555;
    margin-bottom: 1rem;
  }

  /* ── Responsive ─────────────────────────────────────────────────── */
  @media (max-width: 600px) {
    .main { padding: 1.25rem 0.75rem; }
    .card { padding: 1.25rem 1rem; }
    .staff-table th:nth-child(2),
    .staff-table td:nth-child(2) { display: none; }
    .page-header { flex-direction: column; align-items: flex-start; gap: 0.75rem; }
    .nav { padding: 0.75rem 1rem; }
    .nav-user { display: none; }
  }
`;

function layout(title: string, displayName: string, content: string, showManageRoles = false): string {
  const tabBar = showManageRoles
    ? `<div class="page-tabs">
        <a href="/staff" class="page-tab active">Staff</a>
        <a href="/roles" class="page-tab">Roles</a>
      </div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${esc(title)} — LimeHQ</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>${SHARED_CSS}</style>
</head>
<body>
  <nav class="nav">
    <a href="/launcher" class="nav-brand">
      <img src="/images/limehq-logo.png" alt="LimeHQ" class="nav-brand-logo"/>
    </a>
    <div class="nav-right">
      <div class="user-menu">
        <button class="user-menu-trigger" id="user-menu-btn" aria-haspopup="true" aria-expanded="false">
          ${esc(displayName)} <span class="user-menu-caret">▾</span>
        </button>
        <div class="user-menu-dropdown" id="user-menu-dropdown">
          <a href="/account/password" class="user-menu-item">Change password</a>
          <button class="user-menu-item user-menu-signout" id="signout-btn">Sign out</button>
        </div>
      </div>
    </div>
  </nav>
  ${tabBar}
  <main class="main">
    ${content}
  </main>
  <script src="/js/nav.js"></script>
</body>
</html>`;
}

// ------------------------------------------------------------------ //
// Zod schemas                                                         //
// ------------------------------------------------------------------ //

const createStaffSchema = z.object({
  display_name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().email("Enter a valid email address"),
  role_template_id: z.coerce.number().int().positive("Role is required"),
  // Length/complexity itself is checked by the shared validatePasswordStrength()
  // in the route handler (src/auth/password.ts) so the error message can list
  // every missing requirement, not just fail on the first zod rule.
  password: z.string().min(1, "Password is required"),
});

const updateStaffSchema = z.object({
  display_name: z.string().trim().min(1, "Name is required"),
  email: z.string().trim().email("Enter a valid email address"),
  role_template_id: z.coerce.number().int().positive("Role is required"),
  active: z.string().optional(), // checkbox value — present = "on", absent = undefined
});

// ------------------------------------------------------------------ //
// DB helpers                                                          //
// ------------------------------------------------------------------ //

interface RoleTemplate {
  id: number;
  name: string;
  system_role_key: string | null;
}

interface StaffRow {
  id: number;
  display_name: string;
  email: string;
  active: boolean;
  role_template_id: number;
  role_name: string;
  system_role_key: string | null;
  // Carried over from the old dashboard "Manage Staff" screen, per Jason
  // directly, when that screen was retired in favor of this one.
  last_login_at: string | null;
  // Soft-delete marker (migration 0012). Non-null means this account was
  // "deleted" — fetchAllStaff excludes these; fetchOneStaff still returns
  // them so the delete-confirmation page and audit trail can read the row,
  // but every other route that receives a deleted target treats it as 404.
  deleted_at: string | null;
}

async function fetchRoles(): Promise<RoleTemplate[]> {
  const pool = getAppPool();
  const result = await pool.query<RoleTemplate>(
    `SELECT id, name, system_role_key FROM role_templates ORDER BY name`,
  );
  return result.rows;
}

async function fetchAllStaff(): Promise<StaffRow[]> {
  const pool = getAppPool();
  const result = await pool.query<StaffRow>(
    `SELECT u.id, u.display_name, u.email, u.active,
            u.role_template_id, rt.name AS role_name, rt.system_role_key,
            u.last_login_at, u.deleted_at
     FROM users u
     JOIN role_templates rt ON rt.id = u.role_template_id
     WHERE u.deleted_at IS NULL
     ORDER BY u.display_name`,
  );
  return result.rows;
}

async function fetchOneStaff(id: number): Promise<StaffRow | null> {
  const pool = getAppPool();
  const result = await pool.query<StaffRow>(
    `SELECT u.id, u.display_name, u.email, u.active,
            u.role_template_id, rt.name AS role_name, rt.system_role_key,
            u.last_login_at, u.deleted_at
     FROM users u
     JOIN role_templates rt ON rt.id = u.role_template_id
     WHERE u.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

// ------------------------------------------------------------------ //
// Role dropdown HTML                                                  //
// ------------------------------------------------------------------ //

function roleOptions(roles: RoleTemplate[], selectedId: number | null): string {
  // pg may return integer columns as strings in some query paths, so coerce
  // both sides to Number before comparing to avoid type-mismatch misses.
  return roles
    .map(
      (r) =>
        `<option value="${esc(r.id)}"${Number(r.id) === Number(selectedId) ? " selected" : ""}>${esc(r.name)}</option>`,
    )
    .join("\n");
}

// ------------------------------------------------------------------ //
// GET /staff  — staff list                                            //
// ------------------------------------------------------------------ //

router.get("/", async (req, res, next) => {
  try {
    const canView = await hasPermission(req.user.userId, "limehq.staff_management.view");
    if (!canView) {
      throw new ApiError(403, "You do not have permission to manage staff.");
    }
    const canEdit = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    const canDelete = await hasPermission(req.user.userId, "limehq.staff_management.delete");
    const [displayName, staff, canManageRoles] = await Promise.all([
      getDisplayName(req.user.userId),
      fetchAllStaff(),
      hasPermission(req.user.userId, "limehq.role_management.view"),
    ]);

    const rows = staff
      .map((u) => {
        const isOwner = u.system_role_key === "owner";
        const isSelf = u.id === req.user.userId;
        const activeBadge = u.active
          ? `<span class="badge badge-active">Active</span>`
          : `<span class="badge badge-inactive">Inactive</span>`;
        const ownerBadge = isOwner ? ` <span class="badge badge-owner">Owner</span>` : "";
        const editBtn =
          !isOwner && canEdit
            ? `<a href="/staff/${esc(u.id)}/edit" class="btn-secondary" style="font-size:0.8rem;padding:0.3rem 0.75rem">Edit</a>`
            : "";
        const permBtn = !isOwner
          ? `<a href="/staff/${esc(u.id)}/permissions" class="btn-secondary" style="font-size:0.8rem;padding:0.3rem 0.75rem">Permissions</a>`
          : "";
        // "Lost my phone" reset — the ONLY recovery path for non-Owner
        // staff (no backup codes). Same permission gate as Edit; never
        // shown for the Owner row (mirrors the isOwner guard already used
        // for editBtn/deleteBtn above).
        const reset2faBtn =
          !isOwner && canEdit
            ? `<a href="/staff/${esc(u.id)}/reset-2fa" class="btn-secondary" style="font-size:0.8rem;padding:0.3rem 0.75rem">Reset 2FA</a>`
            : "";
        // Can't delete the Owner account or your own account (locking
        // yourself out isn't recoverable from inside this same UI).
        const deleteBtn =
          !isOwner && !isSelf && canDelete
            ? `<a href="/staff/${esc(u.id)}/delete" class="btn-secondary" style="font-size:0.8rem;padding:0.3rem 0.75rem;color:#dc2626;border-color:#fca5a5">Delete</a>`
            : "";
        return `
      <tr>
        <td>${esc(u.display_name)}</td>
        <td>${esc(u.email)}</td>
        <td>${esc(u.role_name)}${ownerBadge}</td>
        <td>${activeBadge}</td>
        <td>${esc(formatLastLogin(u.last_login_at))}</td>
        <td style="text-align:right;white-space:nowrap;display:flex;gap:0.4rem;justify-content:flex-end">${editBtn}${permBtn}${reset2faBtn}${deleteBtn}</td>
      </tr>`;
      })
      .join("");

    const addBtn = canEdit
      ? `<a href="/staff/new" class="btn-primary">+ Add Staff</a>`
      : "";

    const deletedBanner =
      req.query["deleted"] === "1"
        ? `<div class="success-banner">Staff member deleted.</div>`
        : "";
    const reset2faBanner =
      req.query["reset2fa"] === "1"
        ? `<div class="success-banner">Two-factor authentication reset. They'll be asked to set it up again next time they sign in.</div>`
        : "";

    const content = `
      <div class="card">
        <div class="page-header">
          <h1 class="page-title">Manage Staff</h1>
          ${addBtn}
        </div>
        ${deletedBanner}
        ${reset2faBanner}
        <table class="staff-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last Login</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="6" style="color:#999;text-align:center;padding:2rem">No staff found.</td></tr>'}
          </tbody>
        </table>
      </div>`;

    res.send(layout("Manage Staff", displayName, content, canManageRoles));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// GET /staff/new  — add-staff form                                    //
// ------------------------------------------------------------------ //

router.get("/new", async (req, res, next) => {
  try {
    const canEdit = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    if (!canEdit) {
      throw new ApiError(403, "You do not have permission to add staff.");
    }
    const [displayName, roles] = await Promise.all([
      getDisplayName(req.user.userId),
      fetchRoles(),
    ]);
    res.send(layout("Add Staff Member", displayName, addStaffForm(roles, {}, null)));
  } catch (err) {
    next(err);
  }
});

function addStaffForm(
  roles: RoleTemplate[],
  values: Partial<z.infer<typeof createStaffSchema>>,
  errorMsg: string | null,
): string {
  return `
    <div class="card" style="max-width:520px">
      <div class="page-header">
        <h1 class="page-title">Add Staff Member</h1>
      </div>
      ${errorMsg ? `<div class="error-banner">${esc(errorMsg)}</div>` : ""}
      <form method="POST" action="/staff">
        <div class="form-group">
          <label for="display_name">Full Name</label>
          <input type="text" id="display_name" name="display_name"
                 value="${esc(values.display_name ?? "")}" required autocomplete="name"/>
        </div>
        <div class="form-group">
          <label for="email">Email Address</label>
          <input type="email" id="email" name="email"
                 value="${esc(values.email ?? "")}" required autocomplete="email"/>
        </div>
        <div class="form-group">
          <label for="role_template_id">Role</label>
          <select id="role_template_id" name="role_template_id" required>
            <option value="">— select a role —</option>
            ${roleOptions(roles, values.role_template_id ?? null)}
          </select>
        </div>
        <div class="form-group">
          <label for="password">Temporary Password</label>
          <input type="password" id="password" name="password"
                 required autocomplete="new-password" minlength="12"
                 placeholder="12+ characters, incl. uppercase, number, symbol"/>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn-primary">Add Staff Member</button>
          <a href="/staff" class="btn-secondary">Cancel</a>
        </div>
      </form>
    </div>`;
}

// ------------------------------------------------------------------ //
// POST /staff  — create staff member                                  //
// ------------------------------------------------------------------ //

router.post("/", async (req, res, next) => {
  try {
    const canEdit = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    if (!canEdit) {
      throw new ApiError(403, "You do not have permission to add staff.");
    }

    const parsed = createStaffSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0]?.message ?? "Invalid input";
      const [displayName, roles] = await Promise.all([
        getDisplayName(req.user.userId),
        fetchRoles(),
      ]);
      res
        .status(400)
        .send(
          layout(
            "Add Staff Member",
            displayName,
            addStaffForm(roles, req.body as Record<string, string>, firstError),
          ),
        );
      return;
    }

    const { display_name, email, role_template_id, password } = parsed.data;

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      const [displayName, roles] = await Promise.all([
        getDisplayName(req.user.userId),
        fetchRoles(),
      ]);
      res
        .status(400)
        .send(
          layout(
            "Add Staff Member",
            displayName,
            addStaffForm(roles, req.body as Record<string, string>, strength.errors.join(" ")),
          ),
        );
      return;
    }

    const passwordHash = await hashPassword(password);
    const pool = getAppPool();

    let newUserId: number;
    try {
      const insertResult = await pool.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, display_name, role_template_id, active)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [email.toLowerCase(), passwordHash, display_name, role_template_id],
      );
      newUserId = insertResult.rows[0].id;
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        const [displayName, roles] = await Promise.all([
          getDisplayName(req.user.userId),
          fetchRoles(),
        ]);
        res.status(400).send(
          layout(
            "Add Staff Member",
            displayName,
            addStaffForm(
              roles,
              req.body as Record<string, string>,
              `An account with the email "${email}" already exists.`,
            ),
          ),
        );
        return;
      }
      throw err;
    }

    // Send admin straight to the new person's permissions page.
    res.redirect(302, `/staff/${newUserId}/permissions?new=1`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// GET /staff/:id/edit  — edit form                                    //
// ------------------------------------------------------------------ //

router.get("/:id/edit", async (req, res, next) => {
  try {
    const canView = await hasPermission(req.user.userId, "limehq.staff_management.view");
    if (!canView) {
      throw new ApiError(403, "You do not have permission to manage staff.");
    }
    const canEdit = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    if (!canEdit) {
      throw new ApiError(403, "You do not have permission to edit staff.");
    }

    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid staff ID.");

    const [displayName, target, roles] = await Promise.all([
      getDisplayName(req.user.userId),
      fetchOneStaff(id),
      fetchRoles(),
    ]);

    if (!target || target.deleted_at) throw new ApiError(404, "Staff member not found.");
    if (target.system_role_key === "owner") {
      throw new ApiError(403, "The Owner account cannot be edited.");
    }

    const passwordReset = req.query["reset"] === "1";
    res.send(layout("Edit Staff Member", displayName, editStaffForm(target, roles, null, passwordReset)));
  } catch (err) {
    next(err);
  }
});

function editStaffForm(
  target: StaffRow,
  roles: RoleTemplate[],
  errorMsg: string | null,
  passwordReset = false,
): string {
  const checkedAttr = target.active ? " checked" : "";
  const resetBanner = passwordReset
    ? `<div class="success-banner">Password reset successfully.</div>`
    : "";
  return `
    <div class="card" style="max-width:520px">
      <div class="page-header">
        <h1 class="page-title">Edit Staff Member</h1>
      </div>
      ${errorMsg ? `<div class="error-banner">${esc(errorMsg)}</div>` : ""}
      ${resetBanner}
      <form method="POST" action="/staff/${esc(target.id)}">
        <div class="form-group">
          <label for="display_name">Full Name</label>
          <input type="text" id="display_name" name="display_name"
                 value="${esc(target.display_name)}" required autocomplete="name"/>
        </div>
        <div class="form-group">
          <label for="email">Email Address</label>
          <input type="email" id="email" name="email"
                 value="${esc(target.email)}" required autocomplete="email"/>
        </div>
        <div class="form-group">
          <label for="role_template_id">Role</label>
          <select id="role_template_id" name="role_template_id" required>
            ${roleOptions(roles, target.role_template_id)}
          </select>
        </div>
        <div class="form-group">
          <div class="checkbox-row">
            <input type="checkbox" id="active" name="active" value="on"${checkedAttr}/>
            <label for="active">Active — uncheck to deactivate this account</label>
          </div>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn-primary">Save Changes</button>
          <a href="/staff/${esc(target.id)}/reset-password" class="btn-secondary">Reset Password</a>
          <a href="/staff" class="btn-secondary">Cancel</a>
        </div>
      </form>
    </div>`;
}

// ------------------------------------------------------------------ //
// Permissions-page DB helpers                                         //
// ------------------------------------------------------------------ //

interface CatalogRow {
  permission_key: string;
  label: string;
  module: string;
  sort_order: number;
}

interface RoleTemplateWithPerms {
  id: number;
  name: string;
  system_role_key: string | null;
  granted_keys: string[];
}

async function fetchCatalog(): Promise<CatalogRow[]> {
  const pool = getAppPool();
  const r = await pool.query<CatalogRow>(
    `SELECT permission_key, label, module, sort_order
     FROM permission_catalog ORDER BY sort_order`,
  );
  return r.rows;
}

async function fetchRoleTemplatesWithPerms(): Promise<RoleTemplateWithPerms[]> {
  const pool = getAppPool();
  const roles = await pool.query<{ id: number; name: string; system_role_key: string | null }>(
    `SELECT id, name, system_role_key FROM role_templates
     ORDER BY (CASE WHEN system_role_key = 'owner' THEN 0 ELSE 1 END), name`,
  );
  const perms = await pool.query<{ role_template_id: number; permission_key: string }>(
    `SELECT role_template_id, permission_key FROM role_template_permissions WHERE granted = true`,
  );
  const permsByRole = new Map<number, string[]>();
  for (const p of perms.rows) {
    const arr = permsByRole.get(p.role_template_id) ?? [];
    arr.push(p.permission_key);
    permsByRole.set(p.role_template_id, arr);
  }
  return roles.rows.map((r) => ({
    ...r,
    granted_keys: permsByRole.get(r.id) ?? [],
  }));
}

const MODULE_LABEL: Record<string, string> = {
  dashboard: "Dashboard",
  late_rent_notices: "Late Rent Notices",
  limehq: "LimeHQ",
  limona: "Limona",
};

function buildPermissionsChecklist(
  catalog: CatalogRow[],
  breakdown: PermissionBreakdown,
  canEdit: boolean,
): string {
  const moduleOrder: string[] = [];
  const byModule = new Map<string, CatalogRow[]>();
  for (const row of catalog) {
    if (!byModule.has(row.module)) {
      moduleOrder.push(row.module);
      byModule.set(row.module, []);
    }
    byModule.get(row.module)!.push(row);
  }

  const sections = moduleOrder.map((mod) => {
    const label = MODULE_LABEL[mod] ?? mod.replace(/_/g, " ");
    const items = (byModule.get(mod) ?? [])
      .map((p) => {
        const checked = breakdown.effectiveKeys.has(p.permission_key) ? " checked" : "";
        const disabled = !canEdit ? " disabled" : "";
        const fieldName = `perm_${p.permission_key}`;

        // A personal override "counts" as an exception only when its value
        // actually differs from the role's own default — an override row
        // that happens to match the role isn't shown as an exception.
        const hasOverride = breakdown.overrides.has(p.permission_key);
        const overrideGranted = breakdown.overrides.get(p.permission_key);
        const roleGranted = breakdown.roleGrantedKeys.has(p.permission_key);
        const isException = hasOverride && overrideGranted !== roleGranted;
        const sourceTag = isException
          ? `<span class="perm-source perm-source-override">(individual override)</span>`
          : `<span class="perm-source perm-source-role">(from role)</span>`;

        return `
          <div class="perm-row">
            <input type="checkbox" id="${esc(fieldName)}" name="${esc(fieldName)}"
                   value="on"${checked}${disabled}
                   data-key="${esc(p.permission_key)}"/>
            <label for="${esc(fieldName)}">${esc(p.label)}</label>
            ${sourceTag}
          </div>`;
      })
      .join("");
    return `
      <div class="perm-module">
        <div class="perm-module-name">${esc(label)}</div>
        ${items}
      </div>`;
  });

  return sections.join("");
}

// ------------------------------------------------------------------ //
// GET /staff/:id/permissions                                          //
// ------------------------------------------------------------------ //

router.get("/:id/permissions", async (req, res, next) => {
  try {
    const canView = await hasPermission(req.user.userId, "limehq.staff_management.view");
    if (!canView) throw new ApiError(403, "You do not have permission to manage staff.");
    const canEdit = await hasPermission(req.user.userId, "limehq.staff_management.edit");

    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid staff ID.");

    const [displayName, target, catalog, roleTemplates] = await Promise.all([
      getDisplayName(req.user.userId),
      fetchOneStaff(id),
      fetchCatalog(),
      fetchRoleTemplatesWithPerms(),
    ]);

    if (!target || target.deleted_at) throw new ApiError(404, "Staff member not found.");

    const breakdown = await getPermissionBreakdown(id, target.role_template_id);

    const isOwner = target.system_role_key === "owner";
    const isNew = req.query["new"] === "1";
    const saved = req.query["saved"] === "1";

    const initials = target.display_name
      .split(" ")
      .map((w: string) => w[0] ?? "")
      .slice(0, 2)
      .join("")
      .toUpperCase();

    const templatesJson = JSON.stringify(
      roleTemplates.map((r) => ({ id: r.id, name: r.name, keys: r.granted_keys })),
    );

    const bannerHtml = isNew
      ? `<div class="success-banner">Staff member added. Set their permissions below, then save.</div>`
      : saved
        ? `<div class="success-banner">Permissions saved.</div>`
        : "";

    const ownerNote = isOwner
      ? `<div class="owner-note">Owners always have all permissions — nothing to configure.</div>`
      : "";

    const checklist = isOwner
      ? ""
      : buildPermissionsChecklist(catalog, breakdown, canEdit);

    const templateDropdown = !isOwner && canEdit
      ? `<div class="template-bar">
          <label for="role-template-select" class="template-label">Start from a role template:</label>
          <select id="role-template-select" data-templates="${esc(templatesJson)}">
            <option value="">— pick a template —</option>
            ${roleTemplates
              .filter((r) => r.system_role_key !== "owner")
              .map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`)
              .join("")}
          </select>
          <button type="button" id="apply-template-btn" class="btn-secondary">Apply</button>
        </div>`
      : "";

    const saveBtn = !isOwner && canEdit
      ? `<button type="submit" class="btn-primary save-btn">Save Permissions</button>`
      : "";

    const formOpen  = !isOwner && canEdit ? `<form method="POST" action="/staff/${esc(id)}/permissions">` : `<div>`;
    const formClose = !isOwner && canEdit ? `</form>` : `</div>`;

    const content = `
      <div class="card">
        <div class="person-header">
          <a href="/staff" class="back-link">← Manage Staff</a>
          <div class="person-avatar">${esc(initials)}</div>
          <div class="person-info">
            <div class="person-name">${esc(target.display_name)}</div>
            <div class="person-meta">${esc(target.email)} · ${esc(target.role_name)}</div>
          </div>
        </div>
        ${bannerHtml}
        ${ownerNote}
        ${templateDropdown}
        ${formOpen}
          <div class="checklist-grid">
            ${checklist}
          </div>
          ${saveBtn}
        ${formClose}
      </div>`;

    const templateScript = !isOwner && canEdit
      ? `<script src="/js/staff-permissions.js"></script>`
      : "";

    res.send(layout("Permissions", displayName, content) + templateScript);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// POST /staff/:id/permissions                                         //
// ------------------------------------------------------------------ //

router.post("/:id/permissions", async (req, res, next) => {
  try {
    const canEdit = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    if (!canEdit) throw new ApiError(403, "You do not have permission to edit permissions.");

    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid staff ID.");

    const target = await fetchOneStaff(id);
    if (!target || target.deleted_at) throw new ApiError(404, "Staff member not found.");
    if (target.system_role_key === "owner") throw new ApiError(403, "Owner permissions cannot be edited.");

    const catalog = await fetchCatalog();
    const body = req.body as Record<string, string>;
    const pool = getAppPool();

    // Only the role baseline matters here (not any prior override) — the
    // submitted state is compared against what the CURRENT role grants so
    // that user_permission_overrides only ever holds genuine exceptions.
    const breakdown = await getPermissionBreakdown(id, target.role_template_id);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of catalog) {
        const isGranted = body[`perm_${row.permission_key}`] === "on";
        const roleDefault = breakdown.roleGrantedKeys.has(row.permission_key);
        if (isGranted === roleDefault) {
          // Matches the role's default — drop any stale override so this
          // permission cleanly falls back to "inherited from role."
          await client.query(
            `DELETE FROM user_permission_overrides
             WHERE user_id = $1 AND permission_key = $2`,
            [id, row.permission_key],
          );
        } else {
          // Genuine exception — record it as a personal override.
          await client.query(
            `INSERT INTO user_permission_overrides (user_id, permission_key, granted)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, permission_key) DO UPDATE SET granted = $3, updated_at = now()`,
            [id, row.permission_key, isGranted],
          );
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.redirect(302, `/staff/${id}/permissions?saved=1`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// GET /staff/:id/reset-password  — reset-password form               //
// ------------------------------------------------------------------ //

router.get("/:id/reset-password", async (req, res, next) => {
  try {
    const canEdit = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    if (!canEdit) throw new ApiError(403, "You do not have permission to reset passwords.");

    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid staff ID.");

    const [displayName, target] = await Promise.all([
      getDisplayName(req.user.userId),
      fetchOneStaff(id),
    ]);

    if (!target || target.deleted_at) throw new ApiError(404, "Staff member not found.");
    if (target.system_role_key === "owner") throw new ApiError(403, "The Owner password cannot be reset here.");

    res.send(layout("Reset Password", displayName, resetPasswordForm(target, null)));
  } catch (err) {
    next(err);
  }
});

function resetPasswordForm(target: StaffRow, errorMsg: string | null): string {
  return `
    <div class="card" style="max-width:480px">
      <div class="page-header">
        <h1 class="page-title">Reset Password</h1>
      </div>
      <p style="font-size:0.9rem;color:#555;margin-bottom:1.25rem">
        Setting a new password for <strong>${esc(target.display_name)}</strong>.
        They will need to use this new password the next time they sign in.
      </p>
      ${errorMsg ? `<div class="error-banner">${esc(errorMsg)}</div>` : ""}
      <form method="POST" action="/staff/${esc(target.id)}/reset-password">
        <div class="form-group">
          <label for="new_password">New Password</label>
          <input type="password" id="new_password" name="new_password"
                 required autocomplete="new-password" minlength="12"
                 placeholder="12+ characters, incl. uppercase, number, symbol"/>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn-primary">Set New Password</button>
          <a href="/staff/${esc(target.id)}/edit" class="btn-secondary">Cancel</a>
        </div>
      </form>
    </div>`;
}

// ------------------------------------------------------------------ //
// POST /staff/:id/reset-password  — apply new password               //
// ------------------------------------------------------------------ //

router.post("/:id/reset-password", async (req, res, next) => {
  try {
    const canEdit = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    if (!canEdit) throw new ApiError(403, "You do not have permission to reset passwords.");

    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid staff ID.");

    const target = await fetchOneStaff(id);
    if (!target || target.deleted_at) throw new ApiError(404, "Staff member not found.");
    if (target.system_role_key === "owner") throw new ApiError(403, "The Owner password cannot be reset here.");

    const newPassword = String((req.body as Record<string, string>).new_password ?? "").trim();
    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      const displayName = await getDisplayName(req.user.userId);
      res.status(400).send(layout("Reset Password", displayName, resetPasswordForm(target, strength.errors.join(" "))));
      return;
    }

    const passwordHash = await hashPassword(newPassword);
    const pool = getAppPool();
    await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2`,
      [passwordHash, id],
    );

    res.redirect(302, `/staff/${id}/edit?reset=1`);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// POST /staff/:id  — update staff member                             //
// ------------------------------------------------------------------ //

router.post("/:id", async (req, res, next) => {
  try {
    const canEdit = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    if (!canEdit) {
      throw new ApiError(403, "You do not have permission to edit staff.");
    }

    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid staff ID.");

    // Re-fetch to verify the target hasn't become owner in the meantime.
    const target = await fetchOneStaff(id);
    if (!target || target.deleted_at) throw new ApiError(404, "Staff member not found.");
    if (target.system_role_key === "owner") {
      throw new ApiError(403, "The Owner account cannot be edited.");
    }

    const parsed = updateStaffSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0]?.message ?? "Invalid input";
      const [displayName, roles] = await Promise.all([
        getDisplayName(req.user.userId),
        fetchRoles(),
      ]);
      const merged: StaffRow = {
        ...target,
        display_name: (req.body as Record<string, string>).display_name ?? target.display_name,
        email: (req.body as Record<string, string>).email ?? target.email,
        role_template_id:
          parseInt((req.body as Record<string, string>).role_template_id ?? "", 10) ||
          target.role_template_id,
        active: (req.body as Record<string, string>).active === "on",
      };
      res
        .status(400)
        .send(layout("Edit Staff Member", displayName, editStaffForm(merged, roles, firstError)));
      return;
    }

    const { display_name, email, role_template_id, active } = parsed.data;
    const isActive = active === "on";
    const pool = getAppPool();

    try {
      await pool.query(
        `UPDATE users
         SET display_name      = $1,
             email             = $2,
             role_template_id  = $3,
             active            = $4,
             updated_at        = now()
         WHERE id = $5`,
        [display_name, email.toLowerCase(), role_template_id, isActive, id],
      );
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        const [displayName, roles] = await Promise.all([
          getDisplayName(req.user.userId),
          fetchRoles(),
        ]);
        const merged: StaffRow = {
          ...target,
          display_name,
          email,
          role_template_id,
          active: isActive,
        };
        res.status(400).send(
          layout(
            "Edit Staff Member",
            displayName,
            editStaffForm(
              merged,
              roles,
              `Another account is already using the email "${email}".`,
            ),
          ),
        );
        return;
      }
      throw err;
    }

    res.redirect(302, "/staff");
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// GET /staff/:id/delete  — delete confirmation page                   //
// ------------------------------------------------------------------ //
// Soft-delete only (migration 0012) — see that migration's comment for why
// a hard DELETE isn't safe here. This is a stronger action than deactivate,
// so — matching the reset-password confirm-page precedent above — it gets
// its own page with an explicit confirm step rather than a single click.

function deleteStaffForm(target: StaffRow, errorMsg: string | null): string {
  return `
    <div class="card" style="max-width:480px">
      <div class="page-header">
        <h1 class="page-title">Delete Staff Member</h1>
      </div>
      <p style="font-size:0.9rem;color:#555;margin-bottom:1.25rem">
        This will remove <strong>${esc(target.display_name)}</strong> from Manage Staff and
        permanently disable their sign-in. This cannot be undone from this screen.
        Their name stays attached to any historical records they created (e.g. Map
        flags) for attribution — visible only to Owner/Admin viewers once deleted.
      </p>
      ${errorMsg ? `<div class="error-banner">${esc(errorMsg)}</div>` : ""}
      <form method="POST" action="/staff/${esc(target.id)}/delete">
        <div class="form-actions">
          <button type="submit" class="btn-primary" style="background:#dc2626">Delete ${esc(target.display_name)}</button>
          <a href="/staff" class="btn-secondary">Cancel</a>
        </div>
      </form>
    </div>`;
}

router.get("/:id/delete", async (req, res, next) => {
  try {
    const canDelete = await hasPermission(req.user.userId, "limehq.staff_management.delete");
    if (!canDelete) throw new ApiError(403, "You do not have permission to delete staff.");

    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid staff ID.");
    if (id === req.user.userId) throw new ApiError(403, "You cannot delete your own account.");

    const [displayName, target] = await Promise.all([
      getDisplayName(req.user.userId),
      fetchOneStaff(id),
    ]);

    if (!target || target.deleted_at) throw new ApiError(404, "Staff member not found.");
    if (target.system_role_key === "owner") throw new ApiError(403, "The Owner account cannot be deleted.");

    res.send(layout("Delete Staff Member", displayName, deleteStaffForm(target, null)));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// POST /staff/:id/delete  — apply soft delete                        //
// ------------------------------------------------------------------ //

router.post("/:id/delete", async (req, res, next) => {
  try {
    const canDelete = await hasPermission(req.user.userId, "limehq.staff_management.delete");
    if (!canDelete) throw new ApiError(403, "You do not have permission to delete staff.");

    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid staff ID.");
    if (id === req.user.userId) throw new ApiError(403, "You cannot delete your own account.");

    const target = await fetchOneStaff(id);
    if (!target || target.deleted_at) throw new ApiError(404, "Staff member not found.");
    if (target.system_role_key === "owner") throw new ApiError(403, "The Owner account cannot be deleted.");

    // Overwrite password_hash with a random, unguessable value rather than
    // clearing it — some code paths may not null-check password_hash before
    // calling bcrypt.compare, so a NULL could throw instead of safely
    // failing. A random hash always fails verifyPassword() cleanly, and
    // deleted_at / active=false already block the account before password
    // check is ever reached anyway (belt-and-suspenders).
    const unusablePasswordHash = await hashPassword(crypto.randomBytes(32).toString("hex"));

    const pool = getAppPool();
    await pool.query(
      `UPDATE users
       SET deleted_at    = now(),
           active        = false,
           password_hash = $1,
           updated_at    = now()
       WHERE id = $2`,
      [unusablePasswordHash, id],
    );

    await writeAuditLog({
      actorUserId: req.user.userId,
      action: "staff.delete",
      targetType: "user",
      targetId: id,
      detail: { email: target.email, display_name: target.display_name, role_name: target.role_name },
    });

    res.redirect(302, "/staff?deleted=1");
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// GET /staff/:id/reset-2fa  — "lost my phone" confirmation page       //
// ------------------------------------------------------------------ //
// The only recovery path for non-Owner staff — there are deliberately no
// backup codes (Jason rejected them). Gated by the same
// limehq.staff_management.edit permission used for other staff-management
// actions on this page; never usable on the Owner row (mirrors the isOwner
// guard already used elsewhere in this file for edit/delete). A stronger-
// than-deactivate action, so it gets its own confirm step rather than a
// bare one-click link — same precedent as delete/reset-password above.

function reset2faForm(target: StaffRow, errorMsg: string | null): string {
  return `
    <div class="card" style="max-width:480px">
      <div class="page-header">
        <h1 class="page-title">Reset Two-Factor Authentication</h1>
      </div>
      <p style="font-size:0.9rem;color:#555;margin-bottom:1.25rem">
        This clears <strong>${esc(target.display_name)}</strong>'s authenticator enrollment and signs
        them out of any existing session immediately. The next time they sign in, they'll be
        required to set up two-factor authentication again from scratch.
      </p>
      ${errorMsg ? `<div class="error-banner">${esc(errorMsg)}</div>` : ""}
      <form method="POST" action="/staff/${esc(target.id)}/reset-2fa">
        <div class="form-actions">
          <button type="submit" class="btn-primary">Reset 2FA for ${esc(target.display_name)}</button>
          <a href="/staff" class="btn-secondary">Cancel</a>
        </div>
      </form>
    </div>`;
}

router.get("/:id/reset-2fa", async (req, res, next) => {
  try {
    const canEdit = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    if (!canEdit) throw new ApiError(403, "You do not have permission to reset two-factor authentication.");

    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid staff ID.");

    const [displayName, target] = await Promise.all([
      getDisplayName(req.user.userId),
      fetchOneStaff(id),
    ]);

    if (!target || target.deleted_at) throw new ApiError(404, "Staff member not found.");
    if (target.system_role_key === "owner") {
      throw new ApiError(403, "The Owner's two-factor authentication cannot be reset here — see the Owner email-recovery flow instead.");
    }

    res.send(layout("Reset 2FA", displayName, reset2faForm(target, null)));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// POST /staff/:id/reset-2fa  — apply the reset                        //
// ------------------------------------------------------------------ //

router.post("/:id/reset-2fa", async (req, res, next) => {
  try {
    const canEdit = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    if (!canEdit) throw new ApiError(403, "You do not have permission to reset two-factor authentication.");

    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid staff ID.");

    const target = await fetchOneStaff(id);
    if (!target || target.deleted_at) throw new ApiError(404, "Staff member not found.");
    if (target.system_role_key === "owner") {
      throw new ApiError(403, "The Owner's two-factor authentication cannot be reset here — see the Owner email-recovery flow instead.");
    }

    const pool = getAppPool();
    // Bumping session_version invalidates any of their already-issued
    // sessions immediately (requireSession.ts compares it against the
    // JWT's stamped value on every request).
    await pool.query(
      `UPDATE users
       SET totp_secret          = NULL,
           totp_enabled_at      = NULL,
           totp_failed_attempts = 0,
           session_version      = session_version + 1,
           updated_at           = now()
       WHERE id = $1`,
      [id],
    );

    await writeAuditLog({
      actorUserId: req.user.userId,
      action: "staff.reset_2fa",
      targetType: "user",
      targetId: id,
      detail: { email: target.email, display_name: target.display_name },
    });

    res.redirect(302, "/staff?reset2fa=1");
  } catch (err) {
    next(err);
  }
});

export { router as staffRouter };
