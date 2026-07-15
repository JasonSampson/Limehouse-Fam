import express, { Router } from "express";
import { z } from "zod";
import { getAppPool } from "../db/pool.js";
import { hashPassword } from "../auth/password.js";
import { hasPermission } from "../auth/permissions.js";
import { requireSession } from "../auth/requireSession.js";
import { ApiError } from "../lib/apiError.js";

const router = Router();

// Parse URL-encoded form bodies (standard HTML form submissions).
router.use(express.urlencoded({ extended: false }));

// Require a valid session on every staff route.
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
    font-family: 'Quicksand', sans-serif;
    font-weight: 700;
    font-size: 1.4rem;
    text-decoration: none;
    letter-spacing: -0.3px;
  }
  .lime-part { color: #74b62e; }
  .hq-part   { color: #009344; }

  .nav-right {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .nav-user {
    font-size: 0.875rem;
    font-weight: 600;
    color: #555;
  }
  .btn-signout {
    background: none;
    border: 1.5px solid #ddd;
    border-radius: 7px;
    padding: 0.35rem 0.875rem;
    font-family: 'Quicksand', sans-serif;
    font-size: 0.85rem;
    font-weight: 600;
    color: #555;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .btn-signout:hover { background: #f5f5f5; border-color: #ccc; }

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

function layout(title: string, displayName: string, content: string): string {
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
      <span class="lime-part">lime</span><span class="hq-part">HQ</span>
    </a>
    <div class="nav-right">
      <span class="nav-user">${esc(displayName)}</span>
      <form method="POST" action="/auth/logout" id="signout-form" style="margin:0">
        <button type="submit" class="btn-signout">Sign out</button>
      </form>
    </div>
  </nav>
  <main class="main">
    ${content}
  </main>
  <script>
    // Intercept sign-out, POST it, then redirect to the login page.
    document.getElementById('signout-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      window.location.href = '/';
    });
  </script>
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
  password: z.string().min(8, "Password must be at least 8 characters"),
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
            u.role_template_id, rt.name AS role_name, rt.system_role_key
     FROM users u
     JOIN role_templates rt ON rt.id = u.role_template_id
     ORDER BY u.display_name`,
  );
  return result.rows;
}

async function fetchOneStaff(id: number): Promise<StaffRow | null> {
  const pool = getAppPool();
  const result = await pool.query<StaffRow>(
    `SELECT u.id, u.display_name, u.email, u.active,
            u.role_template_id, rt.name AS role_name, rt.system_role_key
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
    const [displayName, staff] = await Promise.all([
      getDisplayName(req.user.userId),
      fetchAllStaff(),
    ]);

    const rows = staff
      .map((u) => {
        const isOwner = u.system_role_key === "owner";
        const activeBadge = u.active
          ? `<span class="badge badge-active">Active</span>`
          : `<span class="badge badge-inactive">Inactive</span>`;
        const ownerBadge = isOwner ? ` <span class="badge badge-owner">Owner</span>` : "";
        const editBtn =
          !isOwner && canEdit
            ? `<a href="/staff/${esc(u.id)}/edit" class="btn-secondary" style="font-size:0.8rem;padding:0.3rem 0.75rem">Edit</a>`
            : "";
        return `
      <tr>
        <td>${esc(u.display_name)}</td>
        <td>${esc(u.email)}</td>
        <td>${esc(u.role_name)}${ownerBadge}</td>
        <td>${activeBadge}</td>
        <td style="text-align:right">${editBtn}</td>
      </tr>`;
      })
      .join("");

    const addBtn = canEdit
      ? `<a href="/staff/new" class="btn-primary">+ Add Staff</a>`
      : "";

    const content = `
      <div class="card">
        <div class="page-header">
          <h1 class="page-title">Manage Staff</h1>
          ${addBtn}
        </div>
        <table class="staff-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="5" style="color:#999;text-align:center;padding:2rem">No staff found.</td></tr>'}
          </tbody>
        </table>
      </div>`;

    res.send(layout("Manage Staff", displayName, content));
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
                 required autocomplete="new-password" minlength="8"
                 placeholder="8 characters minimum"/>
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
    const passwordHash = await hashPassword(password);
    const pool = getAppPool();

    try {
      await pool.query(
        `INSERT INTO users (email, password_hash, display_name, role_template_id, active)
         VALUES ($1, $2, $3, $4, true)`,
        [email.toLowerCase(), passwordHash, display_name, role_template_id],
      );
    } catch (err: unknown) {
      // Postgres unique violation code
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

    res.redirect(302, "/staff");
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

    if (!target) throw new ApiError(404, "Staff member not found.");
    if (target.system_role_key === "owner") {
      throw new ApiError(403, "The Owner account cannot be edited.");
    }

    res.send(layout("Edit Staff Member", displayName, editStaffForm(target, roles, null)));
  } catch (err) {
    next(err);
  }
});

function editStaffForm(
  target: StaffRow,
  roles: RoleTemplate[],
  errorMsg: string | null,
): string {
  const checkedAttr = target.active ? " checked" : "";
  return `
    <div class="card" style="max-width:520px">
      <div class="page-header">
        <h1 class="page-title">Edit Staff Member</h1>
      </div>
      ${errorMsg ? `<div class="error-banner">${esc(errorMsg)}</div>` : ""}
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
          <a href="/staff" class="btn-secondary">Cancel</a>
        </div>
      </form>
    </div>`;
}

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
    if (!target) throw new ApiError(404, "Staff member not found.");
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

export { router as staffRouter };
