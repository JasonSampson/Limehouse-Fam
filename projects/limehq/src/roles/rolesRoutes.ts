import express, { Router } from "express";
import { getAppPool } from "../db/pool.js";
import { hasPermission } from "../auth/permissions.js";
import { requireSession } from "../auth/requireSession.js";
import { ApiError } from "../lib/apiError.js";

const router = Router();

router.use(express.urlencoded({ extended: false }));
router.use(requireSession);

// ------------------------------------------------------------------ //
// Utilities                                                           //
// ------------------------------------------------------------------ //

function esc(val: string | number | null | undefined): string {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

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
  .nav-link {
    font-size: 0.875rem;
    font-weight: 600;
    color: #009344;
    text-decoration: none;
    padding: 0.3rem 0;
    border-bottom: 2px solid transparent;
    transition: border-color 0.15s;
  }
  .nav-link:hover { border-color: #009344; }

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
    width: 100%;
    padding: 0.7rem 1.1rem;
    background: #74b62e;
    color: #fff;
    border: none;
    border-radius: 7px;
    font-family: 'Quicksand', sans-serif;
    font-size: 0.95rem;
    font-weight: 700;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.15s;
    margin-top: 1.5rem;
  }
  .btn-primary:hover { background: #67a228; }

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

  /* ── Permissions grid ───────────────────────────────────────────── */
  .grid-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .perm-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .perm-table th.role-header {
    font-weight: 700;
    font-size: 0.8rem;
    text-align: center;
    color: #009344;
    white-space: nowrap;
    padding: 0.6rem 0.75rem;
    border-bottom: 2px solid #eee;
    vertical-align: bottom;
  }
  .perm-table th.label-header {
    text-align: left;
    font-weight: 600;
    font-size: 0.8rem;
    color: #555;
    padding: 0.6rem 0.75rem;
    border-bottom: 2px solid #eee;
  }
  .perm-table tr.module-header td {
    background: #009344;
    color: #fff;
    font-weight: 700;
    font-size: 0.8rem;
    padding: 0.5rem 0.75rem;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }
  .perm-table td.perm-label {
    font-size: 0.875rem;
    color: #333;
    padding: 0.6rem 0.75rem;
    min-width: 200px;
    border-bottom: 1px solid #eee;
  }
  .perm-table td.perm-check {
    text-align: center;
    vertical-align: middle;
    border-bottom: 1px solid #eee;
    padding: 0.4rem 0.5rem;
  }
  .perm-table td.perm-check input[type="checkbox"] {
    accent-color: #74b62e;
    width: 1.1rem;
    height: 1.1rem;
    cursor: pointer;
  }
  .perm-table td.perm-check input[type="checkbox"]:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .perm-table tr.row-alt td { background: #fafafa; }
  .perm-table tr.row-alt td.perm-label { background: #fafafa; }

  /* ── Responsive ─────────────────────────────────────────────────── */
  @media (max-width: 600px) {
    .main { padding: 1.25rem 0.75rem; }
    .card { padding: 1.25rem 1rem; }
    .page-header { flex-direction: column; align-items: flex-start; gap: 0.75rem; }
    .nav { padding: 0.75rem 1rem; }
    .nav-user { display: none; }
  }
`;

function layout(
  title: string,
  displayName: string,
  content: string,
  showManageStaff: boolean,
): string {
  const manageStaffLink = showManageStaff
    ? `<a href="/staff" class="nav-link">Manage Staff</a>`
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
      <span class="lime-part">lime</span><span class="hq-part">HQ</span>
    </a>
    <div class="nav-right">
      ${manageStaffLink}
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
// DB types                                                            //
// ------------------------------------------------------------------ //

interface PermissionCatalogRow {
  id: number;
  module: string;
  feature: string;
  action: string;
  permission_key: string;
  label: string;
  sort_order: number;
}

interface RoleTemplateRow {
  id: number;
  name: string;
  system_role_key: string | null;
}

interface RoleTemplatePermissionRow {
  role_template_id: number;
  permission_key: string;
  granted: boolean;
}

// ------------------------------------------------------------------ //
// DB helpers                                                          //
// ------------------------------------------------------------------ //

async function fetchPermissionCatalog(): Promise<PermissionCatalogRow[]> {
  const pool = getAppPool();
  const result = await pool.query<PermissionCatalogRow>(
    `SELECT id, module, feature, action, permission_key, label, sort_order
     FROM permission_catalog
     ORDER BY module, sort_order`,
  );
  return result.rows;
}

async function fetchRoleTemplates(): Promise<RoleTemplateRow[]> {
  const pool = getAppPool();
  // Owner first, then all others alphabetically.
  const result = await pool.query<RoleTemplateRow>(
    `SELECT id, name, system_role_key
     FROM role_templates
     ORDER BY (CASE WHEN system_role_key = 'owner' THEN 0 ELSE 1 END), name`,
  );
  return result.rows;
}

async function fetchGrantedPermissions(): Promise<RoleTemplatePermissionRow[]> {
  const pool = getAppPool();
  const result = await pool.query<RoleTemplatePermissionRow>(
    `SELECT role_template_id, permission_key, granted
     FROM role_template_permissions
     WHERE granted = true`,
  );
  return result.rows;
}

// ------------------------------------------------------------------ //
// Grid builder                                                        //
// ------------------------------------------------------------------ //

function buildGrid(
  catalog: PermissionCatalogRow[],
  roles: RoleTemplateRow[],
  granted: RoleTemplatePermissionRow[],
  canEdit: boolean,
): string {
  // Build a fast lookup: "roleId|permKey" -> true
  const grantedSet = new Set<string>(
    granted.map((g) => `${g.role_template_id}|${g.permission_key}`),
  );

  // Group catalog rows by module, preserving sort order within each group.
  const moduleOrder: string[] = [];
  const byModule = new Map<string, PermissionCatalogRow[]>();
  for (const row of catalog) {
    if (!byModule.has(row.module)) {
      moduleOrder.push(row.module);
      byModule.set(row.module, []);
    }
    byModule.get(row.module)!.push(row);
  }

  const colCount = roles.length + 1; // +1 for the label column

  // Table header row
  const headerCells = roles
    .map((r) => `<th class="role-header">${esc(r.name)}</th>`)
    .join("");
  const thead = `<thead><tr><th class="label-header">Permission</th>${headerCells}</tr></thead>`;

  // Table body: iterate modules, then permissions
  let rowIndex = 0;
  const tbodyRows: string[] = [];

  for (const module of moduleOrder) {
    const perms = byModule.get(module)!;

    // Module header row
    const moduleLabel: Record<string, string> = {
      dashboard: "Dashboard",
      late_rent_notices: "Late Rent Notices",
      limehq: "LimeHQ",
    };
    const moduleDisplay = moduleLabel[module] ?? module.replace(/_/g, " ");
    tbodyRows.push(
      `<tr class="module-header"><td colspan="${colCount}">${esc(moduleDisplay)}</td></tr>`,
    );

    for (const perm of perms) {
      const altClass = rowIndex % 2 === 1 ? " row-alt" : "";
      rowIndex++;

      const checkboxCells = roles
        .map((role) => {
          const isOwner = role.system_role_key === "owner";
          const isGranted = isOwner || grantedSet.has(`${role.id}|${perm.permission_key}`);
          const checkedAttr = isGranted ? " checked" : "";
          const disabledAttr = isOwner || !canEdit ? " disabled" : "";
          const fieldName = `perm_${role.id}_${perm.permission_key}`;
          return `<td class="perm-check">
            <input type="checkbox" name="${esc(fieldName)}" value="on"${checkedAttr}${disabledAttr}/>
          </td>`;
        })
        .join("");

      tbodyRows.push(
        `<tr class="${altClass}">
          <td class="perm-label">${esc(perm.label)}</td>
          ${checkboxCells}
        </tr>`,
      );
    }
  }

  return `
    <div class="grid-scroll">
      <table class="perm-table">
        ${thead}
        <tbody>${tbodyRows.join("")}</tbody>
      </table>
    </div>`;
}

// ------------------------------------------------------------------ //
// GET /roles                                                          //
// ------------------------------------------------------------------ //

router.get("/", async (req, res, next) => {
  try {
    const canView = await hasPermission(req.user.userId, "limehq.role_management.view");
    if (!canView) {
      throw new ApiError(403, "You do not have permission to view role permissions.");
    }

    const canEdit = await hasPermission(req.user.userId, "limehq.role_management.edit");
    const [displayName, canManageStaff, catalog, roles, granted] = await Promise.all([
      getDisplayName(req.user.userId),
      hasPermission(req.user.userId, "limehq.staff_management.view"),
      fetchPermissionCatalog(),
      fetchRoleTemplates(),
      fetchGrantedPermissions(),
    ]);

    const saved = req.query["saved"] === "1";
    const successBanner = saved
      ? `<div class="success-banner">Permissions saved successfully.</div>`
      : "";

    const grid = buildGrid(catalog, roles, granted, canEdit);

    const saveBtn = canEdit
      ? `<button type="submit" class="btn-primary">Save Permissions</button>`
      : "";

    const formOpen = canEdit ? `<form method="POST" action="/roles">` : `<div>`;
    const formClose = canEdit ? `</form>` : `</div>`;

    const content = `
      <div class="card">
        <div class="page-header">
          <h1 class="page-title">Roles &amp; Permissions</h1>
        </div>
        ${successBanner}
        ${formOpen}
          ${grid}
          ${saveBtn}
        ${formClose}
      </div>`;

    res.send(layout("Roles & Permissions", displayName, content, canManageStaff));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// POST /roles                                                         //
// ------------------------------------------------------------------ //

router.post("/", async (req, res, next) => {
  try {
    const canEdit = await hasPermission(req.user.userId, "limehq.role_management.edit");
    if (!canEdit) {
      throw new ApiError(403, "You do not have permission to edit role permissions.");
    }

    const pool = getAppPool();

    // Fetch non-owner roles and full permission catalog from DB so we can
    // authoritatively determine which checkboxes exist — we never rely solely
    // on what the browser submitted.
    const [roles, catalog] = await Promise.all([
      fetchRoleTemplates(),
      fetchPermissionCatalog(),
    ]);

    const nonOwnerRoles = roles.filter((r) => r.system_role_key !== "owner");
    const allPermKeys = catalog.map((p) => p.permission_key);

    // Parse submitted checkboxes. Only keys matching perm_{integer}_{key} matter.
    const body = req.body as Record<string, string>;
    const submittedChecks = new Set<string>();
    for (const fieldName of Object.keys(body)) {
      const match = fieldName.match(/^perm_(\d+)_(.+)$/);
      if (match && body[fieldName] === "on") {
        submittedChecks.add(`${match[1]}|${match[2]}`);
      }
    }

    // Execute all upserts and deletes in a single transaction.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const role of nonOwnerRoles) {
        for (const permKey of allPermKeys) {
          const lookupKey = `${role.id}|${permKey}`;
          const isChecked = submittedChecks.has(lookupKey);

          if (isChecked) {
            // Upsert: ensure row exists with granted = true.
            await client.query(
              `INSERT INTO role_template_permissions (role_template_id, permission_key, granted)
               VALUES ($1, $2, true)
               ON CONFLICT (role_template_id, permission_key)
               DO UPDATE SET granted = true`,
              [role.id, permKey],
            );
          } else {
            // Remove: unchecked means no explicit grant.
            await client.query(
              `DELETE FROM role_template_permissions
               WHERE role_template_id = $1 AND permission_key = $2`,
              [role.id, permKey],
            );
          }
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.redirect(302, "/roles?saved=1");
  } catch (err) {
    next(err);
  }
});

export { router as rolesRouter };
