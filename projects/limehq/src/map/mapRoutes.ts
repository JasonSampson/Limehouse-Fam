import express, { Router } from "express";
import { z } from "zod";
import { getAppPool } from "../db/pool.js";
import { getMapPool, isMapConfigured } from "./mapPool.js";
import { hasPermission } from "../auth/permissions.js";
import { requireSession } from "../auth/requireSession.js";
import { ApiError } from "../lib/apiError.js";
import { loadEnv } from "../config/env.js";
import {
  fetchActiveMapProperties,
  createExclusion,
  removeExclusion,
  listNamedAreas,
  getNamedArea,
  createNamedArea,
  computeLiveAreaMatches,
  fetchShadowLogSummary,
  activateNamedArea,
  retireNamedArea,
  reasonCodeLabel,
  REASON_CODES_NO_EVIDENCE,
  REASON_CODE_SAFETY,
} from "./mapQueries.js";

const router = Router();

router.use(express.json());
router.use(requireSession);

/** Escape a value for safe insertion into HTML. */
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

function requireMapPool() {
  const pool = getMapPool();
  if (!pool) {
    throw new ApiError(503, "Map is not configured on this server yet (MAP_DATABASE_URL is unset).");
  }
  return pool;
}

// ------------------------------------------------------------------ //
// Shared layout (matches staffRoutes.ts's nav/CSS/Quicksand approach)  //
// ------------------------------------------------------------------ //

const NAV_WORDMARK = `<img src="/images/limehq-logo.png" alt="LimeHQ" class="nav-brand-logo"/>`;

const SHARED_CSS = `
  @font-face { font-family:'Quicksand'; src:url('/fonts/Quicksand-Regular.ttf') format('truetype'); font-weight:400; font-style:normal; }
  @font-face { font-family:'Quicksand'; src:url('/fonts/Quicksand-Medium.ttf') format('truetype'); font-weight:500; font-style:normal; }
  @font-face { font-family:'Quicksand'; src:url('/fonts/Quicksand-Bold.ttf') format('truetype'); font-weight:700; font-style:normal; }
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  html, body { height:100%; }
  body { font-family:'Quicksand',system-ui,sans-serif; background:#f0f4f0; color:#222; }
  .nav { background:#fff; box-shadow:0 1px 4px rgba(0,0,0,0.08); padding:0.6rem 1.25rem; display:flex; align-items:center; justify-content:space-between; position:relative; z-index:20; }
  .nav-brand { display:inline-flex; align-items:center; text-decoration:none; }
  .nav-brand-logo { height:44px; width:auto; display:block; }
  .nav-title { font-size:0.95rem; font-weight:700; color:#333; margin-left:0.75rem; padding-left:0.75rem; border-left:1px solid #ddd; }
  .nav-left { display:flex; align-items:center; }
  .nav-right { display:flex; align-items:center; gap:0.75rem; }
  .nav-link { font-size:0.85rem; font-weight:600; color:#009344; text-decoration:none; padding:.4rem .7rem; border-radius:6px; }
  .nav-link:hover { background:#f0f4f0; }
  .user-menu { position:relative; }
  .user-menu-trigger { background:none; border:none; font-family:'Quicksand',sans-serif; font-size:.85rem; font-weight:600; color:#333; cursor:pointer; display:flex; align-items:center; gap:.3rem; padding:.3rem .5rem; border-radius:7px; }
  .user-menu-trigger:hover { background:#f0f4f0; }
  .user-menu-caret { font-size:.65rem; color:#888; }
  .user-menu-dropdown { position:absolute; right:0; top:calc(100% + .4rem); background:#fff; border:1px solid #e0e8e0; border-radius:10px; box-shadow:0 4px 20px rgba(0,0,0,.12); min-width:175px; z-index:100; padding:.3rem; display:none; }
  .user-menu-dropdown.open { display:block; }
  .user-menu-item { display:block; width:100%; text-align:left; padding:.55rem .875rem; border-radius:7px; font-family:'Quicksand',sans-serif; font-size:.875rem; font-weight:600; color:#333; text-decoration:none; background:none; border:none; cursor:pointer; }
  .user-menu-item:hover { background:#f0f4f0; }
  .user-menu-signout { color:#dc2626; }
  .user-menu-signout:hover { background:#fef2f2; }
  .map-shell { position:absolute; top:0; left:0; right:0; bottom:0; }
  .map-page-body { height:calc(100vh - 49px); position:relative; }
  #map-canvas { position:absolute; inset:0; }
  .not-configured { max-width:520px; margin:3rem auto; background:#fff; border-radius:14px; box-shadow:0 2px 20px rgba(0,0,0,.09); padding:2rem; text-align:center; }

  /* ── Search box control (Places autocomplete, injected into map) ──── */
  .map-search-box {
    background:#fff; border-radius:10px; box-shadow:0 2px 12px rgba(0,0,0,.18);
    margin:12px; padding:0; width:min(340px, 70vw);
  }
  .map-search-box input {
    width:100%; border:none; border-radius:10px; padding:0.7rem 1rem;
    font-family:'Quicksand',sans-serif; font-size:0.95rem; color:#222; outline:none;
  }

  /* ── Loading overlay ────────────────────────────────────────────── */
  .map-loading {
    position:absolute; top:12px; left:50%; transform:translateX(-50%);
    background:#fff; padding:.5rem 1rem; border-radius:8px; box-shadow:0 2px 10px rgba(0,0,0,.15);
    font-size:.85rem; font-weight:600; color:#444; z-index:30; display:flex; align-items:center; gap:.5rem;
  }
  .spinner {
    width:14px; height:14px; border:2px solid #ddd; border-top-color:#74b62e; border-radius:50%;
    animation:spin .7s linear infinite;
  }
  @keyframes spin { to { transform:rotate(360deg); } }

  /* ── Popup / info window content (rendered inside Google's InfoWindow) ── */
  .popup { font-family:'Quicksand',sans-serif; max-width:280px; }
  .popup-photo { width:100%; height:140px; object-fit:cover; border-radius:8px; margin-bottom:.6rem; background:#eee; }
  .popup-photo-placeholder {
    width:100%; height:140px; border-radius:8px; margin-bottom:.6rem;
    background:#eef2ee; color:#999; display:flex; align-items:center; justify-content:center;
    font-size:.8rem; font-weight:600;
  }
  .popup-address { font-weight:700; font-size:.95rem; color:#222; margin-bottom:.15rem; }
  .popup-city { font-size:.8rem; color:#777; margin-bottom:.6rem; }
  .unit-tabs { display:flex; gap:.3rem; flex-wrap:wrap; margin-bottom:.5rem; }
  .unit-tab {
    font-size:.75rem; font-weight:700; padding:.25rem .6rem; border-radius:20px;
    background:#eef2ee; color:#333; border:none; cursor:pointer;
  }
  .unit-tab.active { background:#74b62e; color:#fff; }
  .unit-detail-row { font-size:.83rem; color:#333; margin-bottom:.25rem; }
  .unit-detail-row b { color:#111; }
  .vacant-badge { display:inline-block; background:#f59e0b; color:#fff; font-size:.68rem; font-weight:700; padding:.1rem .5rem; border-radius:20px; margin-left:.3rem; }
  .flag-badge { display:block; background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; border-radius:7px; padding:.5rem .65rem; font-size:.78rem; margin:.5rem 0; }
  .popup-actions { margin-top:.6rem; border-top:1px solid #eee; padding-top:.5rem; }
  .popup-btn {
    font-family:'Quicksand',sans-serif; font-size:.78rem; font-weight:700; border:none; border-radius:6px;
    padding:.4rem .7rem; cursor:pointer; color:#fff; background:#009344; margin-right:.35rem;
  }
  .popup-btn.danger { background:#dc2626; }
  .popup-btn.secondary { background:#fff; color:#333; border:1.5px solid #ddd; }
  .flag-form { margin-top:.5rem; font-size:.8rem; }
  .flag-form label { display:flex; align-items:flex-start; gap:.4rem; font-weight:600; color:#333; margin-bottom:.35rem; cursor:pointer; }
  .flag-form textarea, .flag-form input[type="date"] {
    width:100%; margin-top:.3rem; padding:.4rem .5rem; border:1.5px solid #ddd; border-radius:6px;
    font-family:'Quicksand',sans-serif; font-size:.8rem;
  }
  .flag-form .helper-text { font-size:.72rem; color:#777; margin:.2rem 0 .5rem; }
  .flag-form .safety-fields { display:none; padding:.4rem .5rem; background:#fffbeb; border-radius:7px; margin:.4rem 0; }
  .flag-form .safety-fields.shown { display:block; }
  .form-error { color:#dc2626; font-size:.75rem; margin-top:.3rem; }

  /* ── Named-area tool ────────────────────────────────────────────── */
  .areas-sidebar {
    position:absolute; top:0; left:0; bottom:0; width:340px; max-width:88vw; background:#fff;
    box-shadow:2px 0 12px rgba(0,0,0,.1); overflow-y:auto; z-index:15; padding:1rem;
  }
  .areas-list-item {
    border:1px solid #eee; border-radius:8px; padding:.6rem .75rem; margin-bottom:.5rem; cursor:pointer;
  }
  .areas-list-item:hover { background:#fafafa; }
  .areas-list-item.selected { border-color:#74b62e; background:#f7fcf3; }
  .status-pill { font-size:.65rem; font-weight:700; padding:.1rem .5rem; border-radius:20px; text-transform:uppercase; }
  .status-shadow { background:#e0e7ff; color:#3730a3; }
  .status-active { background:#74b62e; color:#fff; }
  .status-retired { background:#aaa; color:#fff; }
  .activate-warning {
    background:#fffbeb; border:1.5px solid #f59e0b; color:#92400e; border-radius:8px;
    padding:.75rem .9rem; font-size:.82rem; font-weight:600; margin:.75rem 0;
  }
  /* ── Named-Area Tool link (floats over the map, top-right) ────────── */
  .named-area-link { position:absolute; top:0.55rem; right:11.5rem; z-index:25; }
  @media (max-width:600px) {
    .nav-title { display:none; }
    .areas-sidebar { width:100%; height:45%; bottom:auto; }
    /* Google's own search box control (.map-search-box) grows to 70vw on
       a narrow screen and runs directly under this link's fixed
       right:11.5rem desktop position — confirmed colliding at 375px
       width. Drop it below the search box instead of beside it; the
       search box's own margin + height comes to about 65px at this
       width, plus a little breathing room. */
    /* Standing alone under the search box now (not beside other nav items
       any more), floating directly over map tiles — give it the same
       solid card background the search box and loading pill already use,
       so it stays legible over satellite imagery instead of relying on
       plain green text with no backing. */
    .named-area-link {
      top:4.25rem; right:0.75rem; left:0.75rem; text-align:center;
      background:#fff; box-shadow:0 2px 12px rgba(0,0,0,.18); padding:0.65rem 0.7rem;
    }
  }
`;

function layout(title: string, displayName: string, bodyClass: string, content: string, extraHead = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${esc(title)} — LimeHQ</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>${SHARED_CSS}</style>
  ${extraHead}
</head>
<body class="${esc(bodyClass)}">
  <nav class="nav">
    <div class="nav-left">
      <a href="/launcher" class="nav-brand">${NAV_WORDMARK}</a>
      <span class="nav-title">Map</span>
    </div>
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
  ${content}
  <script src="/js/nav.js"></script>
</body>
</html>`;
}

// ------------------------------------------------------------------ //
// GET /map — main internal map page                                   //
// ------------------------------------------------------------------ //

router.get("/", async (req, res, next) => {
  try {
    const canView = await hasPermission(req.user.userId, "map.properties.view");
    if (!canView) throw new ApiError(403, "You do not have permission to view Map.");

    const displayName = await getDisplayName(req.user.userId);

    if (!isMapConfigured()) {
      res.send(
        layout(
          "Map",
          displayName,
          "",
          `<div class="not-configured">
            <h1 style="font-size:1.1rem;margin-bottom:.75rem">Map isn't set up on this server yet</h1>
            <p style="color:#666;font-size:.9rem">MAP_DATABASE_URL isn't configured. Ask Scotty to provision the
            <code>map_staff_app</code> connection string before this page can load property data.</p>
          </div>`,
        ),
      );
      return;
    }

    const [canManageExclusions, canManageAreas, canActivateAreas] = await Promise.all([
      hasPermission(req.user.userId, "map.exclusions.manage"),
      hasPermission(req.user.userId, "map.area_exclusions.manage"),
      hasPermission(req.user.userId, "map.area_exclusions.activate"),
    ]);

    const env = loadEnv();
    const config = {
      googleMapsApiKey: env.GOOGLE_MAPS_API_KEY ?? "",
      apiBase: "/map/api",
      permissions: {
        canManageExclusions,
      },
      reasonCodes: [
        ...REASON_CODES_NO_EVIDENCE.map((code) => ({ code, label: reasonCodeLabel(code), needsEvidence: false })),
        // staff_safety_concern is deliberately listed last and flagged with
        // needsEvidence — client renders the incident_report/review_by
        // fields ONLY for this one code, never for the other four (per
        // spec.md: no free-text reason box for any reason code, ever).
        { code: REASON_CODE_SAFETY, label: reasonCodeLabel(REASON_CODE_SAFETY), needsEvidence: true },
      ],
    };

    const areasLink =
      canManageAreas || canActivateAreas
        ? `<a href="/map/areas" class="nav-link named-area-link">Named-Area Tool</a>`
        : "";

    const content = `
      <div class="map-page-body">
        ${areasLink}
        <div id="map-app" data-config="${esc(JSON.stringify(config))}">
          <div id="map-canvas"></div>
        </div>
      </div>
      <script src="/js/map-internal.js"></script>
      ${config.googleMapsApiKey
        ? `<script src="https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(config.googleMapsApiKey)}&libraries=places&callback=mapInternalInit&loading=async" async defer></script>`
        : ""}
    `;

    res.send(layout("Map", displayName, "", content));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// GET /map/api/properties — pins + popup data                         //
// ------------------------------------------------------------------ //

router.get("/api/properties", async (req, res, next) => {
  try {
    const canView = await hasPermission(req.user.userId, "map.properties.view");
    if (!canView) throw new ApiError(403, "You do not have permission to view Map.");
    // Same permission key staffRoutes.ts already gates staff-edit actions
    // on — used here as the "Owner/Admin" signal for the deleted-staff
    // attribution rule in resolveDisplayNames (mapQueries.ts).
    const viewerCanSeeFormerStaff = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    const pool = requireMapPool();
    const properties = await fetchActiveMapProperties(pool, viewerCanSeeFormerStaff);
    res.json({ ok: true, properties });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// POST /map/api/properties/:id/exclusions — flag "do not pursue"      //
// ------------------------------------------------------------------ //

const createExclusionSchema = z
  .object({
    reason_code: z.enum([...REASON_CODES_NO_EVIDENCE, REASON_CODE_SAFETY]),
    incident_report: z.string().trim().optional(),
    review_by: z.string().trim().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.reason_code === REASON_CODE_SAFETY) {
      if (!val.incident_report || val.incident_report.length < 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["incident_report"],
          message:
            "Must reference a dated, existing record (a Property Meld ticket, an email, etc.) — at least 20 characters, not a description written fresh right now.",
        });
      }
      if (!val.review_by) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["review_by"], message: "A review date is required." });
      }
    } else {
      if (val.incident_report) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["incident_report"],
          message: "This reason code cannot carry a written note — only staff_safety_concern can.",
        });
      }
      if (val.review_by) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["review_by"], message: "This reason code has no review date." });
      }
    }
  });

router.post("/api/properties/:id/exclusions", async (req, res, next) => {
  try {
    const canManage = await hasPermission(req.user.userId, "map.exclusions.manage");
    if (!canManage) throw new ApiError(403, "You do not have permission to flag properties.");

    const propertyId = parseInt(req.params.id ?? "", 10);
    if (isNaN(propertyId)) throw new ApiError(400, "Invalid property ID.");

    const parsed = createExclusionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, parsed.error.errors[0]?.message ?? "Invalid input.");
    }

    // No reason-code-specific permission beyond map.exclusions.manage —
    // resolved 2026-07-20 by Jarvis, directly from Jason: the "selectable
    // only by Jason himself" line in an earlier spec.md draft was stale
    // language from an early negotiation round with Mason. Jason later
    // broadened the policy for the whole do-not-pursue system ("marking
    // any property or area... is restricted to Jason and admin-level staff
    // only," his words, covering every reason code, not just the two
    // originally disputed ones), which is what actually got built:
    // map.exclusions.manage (Owner+Admin) is the only gate on any reason
    // code, including staff_safety_concern — no narrower key exists.
    // spec.md has been corrected to match. staff_safety_concern still gets
    // its own conditional incident_report/review_by fields (enforced by
    // createExclusionSchema above and the DB's CHECK constraint), just not
    // a narrower actor restriction.

    const pool = requireMapPool();
    await createExclusion(pool, {
      propertyId,
      reasonCode: parsed.data.reason_code,
      incidentReport: parsed.data.incident_report ?? null,
      reviewBy: parsed.data.review_by ?? null,
      flaggedByUserId: req.user.userId,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/api/exclusions/:id/remove", async (req, res, next) => {
  try {
    const canManage = await hasPermission(req.user.userId, "map.exclusions.manage");
    if (!canManage) throw new ApiError(403, "You do not have permission to unflag properties.");

    const exclusionId = parseInt(req.params.id ?? "", 10);
    if (isNaN(exclusionId)) throw new ApiError(400, "Invalid exclusion ID.");

    const pool = requireMapPool();
    await removeExclusion(pool, exclusionId, req.user.userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// Named-area exclusion tool                                           //
// ------------------------------------------------------------------ //

async function requireAreaView(userId: number): Promise<{ canManage: boolean; canActivate: boolean }> {
  const [canManage, canActivate] = await Promise.all([
    hasPermission(userId, "map.area_exclusions.manage"),
    hasPermission(userId, "map.area_exclusions.activate"),
  ]);
  if (!canManage && !canActivate) {
    throw new ApiError(403, "You do not have permission to use the named-area exclusion tool.");
  }
  return { canManage, canActivate };
}

router.get("/areas", async (req, res, next) => {
  try {
    const { canManage, canActivate } = await requireAreaView(req.user.userId);
    const displayName = await getDisplayName(req.user.userId);
    const viewerCanSeeFormerStaff = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    const pool = requireMapPool();
    const areas = await listNamedAreas(pool, viewerCanSeeFormerStaff);

    const config = {
      googleMapsApiKey: loadEnv().GOOGLE_MAPS_API_KEY ?? "",
      apiBase: "/map/api",
      permissions: { canManage, canActivate },
      areas,
    };

    const content = `
      <div class="map-page-body">
        <div id="areas-app" data-config="${esc(JSON.stringify(config))}">
          <div id="map-canvas"></div>
        </div>
      </div>
      <script src="/js/map-areas.js"></script>
      ${config.googleMapsApiKey
        ? // No `libraries=drawing` — Google removed that library outright in
          // Maps JS API v3.65 (June 2026); map-areas.js draws boundaries with
          // a plain google.maps.Polygon + click listeners instead, which
          // needs no extra library param.
          `<script src="https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(config.googleMapsApiKey)}&callback=mapAreasInit&loading=async" async defer></script>`
        : ""}
    `;

    res.send(layout("Named-Area Exclusion Tool", displayName, "", content));
  } catch (err) {
    next(err);
  }
});

router.get("/api/areas", async (req, res, next) => {
  try {
    await requireAreaView(req.user.userId);
    const viewerCanSeeFormerStaff = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    const pool = requireMapPool();
    const areas = await listNamedAreas(pool, viewerCanSeeFormerStaff);
    res.json({ ok: true, areas });
  } catch (err) {
    next(err);
  }
});

const boundaryPointSchema = z.object({ lat: z.number(), lng: z.number() });
const createAreaSchema = z.object({
  area_name: z.string().trim().min(1, "Name the area before saving."),
  boundary: z.array(boundaryPointSchema).min(3, "Draw a boundary with at least 3 points."),
});

router.post("/api/areas", async (req, res, next) => {
  try {
    const canManage = await hasPermission(req.user.userId, "map.area_exclusions.manage");
    if (!canManage) throw new ApiError(403, "You do not have permission to create a named area.");

    const parsed = createAreaSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, parsed.error.errors[0]?.message ?? "Invalid input.");

    const pool = requireMapPool();
    // Every area is created in `shadow` status — there is no code path in
    // this route (or anywhere else in this file) that creates one as
    // `active`. See governance-review.md's verdict: NOT APPROVED FOR
    // ACTIVE, approved to build in shadow mode only.
    const id = await createNamedArea(pool, {
      areaName: parsed.data.area_name,
      boundary: parsed.data.boundary,
      createdByUserId: req.user.userId,
    });
    res.json({ ok: true, id });
  } catch (err) {
    next(err);
  }
});

router.post("/api/areas/preview", async (req, res, next) => {
  try {
    const canManage = await hasPermission(req.user.userId, "map.area_exclusions.manage");
    const canActivate = await hasPermission(req.user.userId, "map.area_exclusions.activate");
    if (!canManage && !canActivate) throw new ApiError(403, "You do not have permission to preview an area.");

    const parsed = z.array(boundaryPointSchema).min(3).safeParse(req.body.boundary);
    if (!parsed.success) throw new ApiError(400, "Draw a boundary with at least 3 points before previewing.");

    const pool = requireMapPool();
    const matches = await computeLiveAreaMatches(pool, parsed.data);
    res.json({ ok: true, matches });
  } catch (err) {
    next(err);
  }
});

router.get("/api/areas/:id", async (req, res, next) => {
  try {
    await requireAreaView(req.user.userId);
    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid area ID.");

    const viewerCanSeeFormerStaff = await hasPermission(req.user.userId, "limehq.staff_management.edit");
    const pool = requireMapPool();
    const area = await getNamedArea(pool, id, viewerCanSeeFormerStaff);
    if (!area) throw new ApiError(404, "Area not found.");

    const [matches, shadowLog] = await Promise.all([
      computeLiveAreaMatches(pool, area.boundary),
      fetchShadowLogSummary(pool, id),
    ]);

    res.json({ ok: true, area, liveMatches: matches, shadowLog });
  } catch (err) {
    next(err);
  }
});

router.post("/api/areas/:id/activate", async (req, res, next) => {
  try {
    const canActivate = await hasPermission(req.user.userId, "map.area_exclusions.activate");
    if (!canActivate) throw new ApiError(403, "You do not have permission to activate a named area.");

    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid area ID.");

    const pool = requireMapPool();
    await activateNamedArea(pool, id, req.user.userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/api/areas/:id/retire", async (req, res, next) => {
  try {
    const canActivate = await hasPermission(req.user.userId, "map.area_exclusions.activate");
    if (!canActivate) throw new ApiError(403, "You do not have permission to retire a named area.");

    const id = parseInt(req.params.id ?? "", 10);
    if (isNaN(id)) throw new ApiError(400, "Invalid area ID.");

    const pool = requireMapPool();
    await retireNamedArea(pool, id, req.user.userId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export { router as mapRouter };
