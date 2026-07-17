import express from "express";
import helmet from "helmet";
import type { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./config/env.js";
import { logInfo, logError } from "./lib/appLogger.js";
import { authRouter } from "./auth/authRoutes.js";
import { staffRouter } from "./staff/staffRoutes.js";
import { rolesRouter } from "./roles/rolesRoutes.js";
import { ApiError } from "./lib/apiError.js";
import { requireSession } from "./auth/requireSession.js";
import { SESSION_COOKIE_NAME } from "./auth/session.js";
import { accountRouter } from "./auth/accountRoutes.js";
import { hasPermission } from "./auth/permissions.js";
import { getAppPool } from "./db/pool.js";

const env = loadEnv();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// The handoff page (see src/auth/authRoutes.ts) POSTs a same-origin-hidden
// form to each sub-app's /auth/limehq-callback so the handoff token never
// lands in a URL or log. Helmet's default form-action ('self') blocks that
// cross-origin submission, so the three sub-app origins must be allowlisted
// explicitly. Filter out any unconfigured (undefined) URLs.
const formActionTargets = [
  "'self'",
  ...[env.LATE_RENT_NOTICES_URL, env.DASHBOARD_URL, env.LIMONA_URL].filter(
    (url): url is string => Boolean(url),
  ),
];

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "form-action": formActionTargets,
      },
    },
  }),
);
// TODO(production): add helmet.hsts({ maxAge: 31536000, includeSubDomains: true }) once behind HTTPS
app.use(express.json());
app.use(cookieParser());

// Health check — no auth required.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Auth routes: login, logout, re-auth, me, handoff.
app.use("/auth", authRouter);

// Staff management routes — protected, session-required.
app.use("/staff", staffRouter);

// Roles & Permissions routes — protected, session-required.
app.use("/roles", rolesRouter);

// Account self-service (change password) — protected, session-required.
app.use("/", accountRouter);

// Static files (login page, fonts, etc.) served before catch-all routes.
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir));

/** Escape a value for safe insertion into HTML. */
function esc(val: string | number | null | undefined): string {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Launcher — session required. Permission-aware tile grid.
app.get(
  "/launcher",
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.cookies?.[SESSION_COOKIE_NAME]) { res.redirect("/"); return; }
    next();
  },
  requireSession,
  async (req, res, next) => {
  try {
    const pool = getAppPool();

    const [nameResult, canDashboard, canLimona, canNotices, canStaff] = await Promise.all([
      pool.query<{ display_name: string }>(
        "SELECT display_name FROM users WHERE id = $1",
        [req.user.userId],
      ),
      hasPermission(req.user.userId, "dashboard.financials.view"),
      hasPermission(req.user.userId, "limona.chat.access"),
      hasPermission(req.user.userId, "late_rent_notices.notices.view"),
      hasPermission(req.user.userId, "limehq.staff_management.view"),
    ]);

    const displayName = nameResult.rows[0]?.display_name ?? "there";
    const firstName = displayName.split(" ")[0];
    const hour = new Date().getHours();
    const greeting =
      hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

    interface TileDef {
      name: string;
      description: string;
      href: string | null;
      iconPath: string;
      available: boolean;
    }

    const tiles: TileDef[] = [
      {
        name: "Dashboard",
        description: "Portfolio overview, financials, and key metrics",
        href: env.DASHBOARD_URL ? "/auth/handoff?app=dashboard" : null,
        iconPath: `<path d="M4 20 L4 12 L8 12 L8 20 M10 20 L10 8 L14 8 L14 20 M16 20 L16 4 L20 4 L20 20 M2 20 L22 20" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
        available: canDashboard,
      },
      {
        name: "Limona",
        description: "Your AI assistant — ask questions, find answers",
        href: env.LIMONA_URL ? "/auth/handoff?app=limona" : null,
        iconPath: `<circle cx="12" cy="10" r="7" stroke="white" stroke-width="2" fill="none"/>
          <path d="M8 10 Q10 7 12 10 Q14 13 16 10" stroke="white" stroke-width="2" stroke-linecap="round" fill="none"/>
          <path d="M10 17 L9 21 L12 19 L15 21 L14 17" stroke="white" stroke-width="1.5" stroke-linejoin="round" fill="none"/>`,
        available: canLimona,
      },
      {
        name: "Late Rent Notices",
        description: "Review balances, generate and send notices",
        href: env.LATE_RENT_NOTICES_URL ? "/auth/handoff?app=late_rent_notices" : null,
        iconPath: `<rect x="5" y="3" width="14" height="18" rx="2" stroke="white" stroke-width="2" fill="none"/>
          <line x1="9" y1="8" x2="15" y2="8" stroke="white" stroke-width="2" stroke-linecap="round"/>
          <line x1="9" y1="12" x2="15" y2="12" stroke="white" stroke-width="2" stroke-linecap="round"/>
          <line x1="9" y1="16" x2="12" y2="16" stroke="white" stroke-width="2" stroke-linecap="round"/>
          <circle cx="17" cy="17" r="4" fill="#e53e3e"/>
          <text x="17" y="21" text-anchor="middle" font-size="6" font-weight="bold" fill="white">!</text>`,
        available: canNotices,
      },
      {
        name: "Staff &amp; Permissions",
        description: "Manage your team members and their access",
        href: "/staff",
        iconPath: `<circle cx="9" cy="7" r="3" stroke="white" stroke-width="2" fill="none"/>
          <path d="M3 20 C3 16.686 5.686 14 9 14" stroke="white" stroke-width="2" stroke-linecap="round" fill="none"/>
          <circle cx="16" cy="10" r="2.5" stroke="white" stroke-width="1.5" fill="none"/>
          <circle cx="16" cy="10" r="5.5" stroke="white" stroke-width="1.5" stroke-dasharray="2 2.5" fill="none"/>
          <line x1="16" y1="4.5" x2="16" y2="6" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="16" y1="14" x2="16" y2="15.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="10.5" y1="10" x2="12" y2="10" stroke="white" stroke-width="1.5" stroke-linecap="round"/>
          <line x1="20" y1="10" x2="21.5" y2="10" stroke="white" stroke-width="1.5" stroke-linecap="round"/>`,
        available: canStaff,
      },
    ];

    const tileCards = tiles
      .filter((t) => t.available)
      .map((t) => {
        const isExternal = t.href && (t.href.startsWith("http://") || t.href.startsWith("https://"));
        const linkAttrs = t.href
          ? `href="${t.href}"${isExternal ? ' target="_blank" rel="noopener"' : ""}`
          : `href="#" class="tile-disabled"`;
        const badge = !t.href
          ? `<span class="badge-soon">Not connected</span>`
          : "";
        return `
        <a ${linkAttrs} class="tile">
          <div class="tile-icon">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              ${t.iconPath}
            </svg>
          </div>
          <div class="tile-body">
            <div class="tile-name">${t.name}${badge}</div>
            <div class="tile-desc">${t.description}</div>
          </div>
          <div class="tile-arrow">→</div>
        </a>`;
      })
      .join("");

    const noApps = tiles.every((t) => !t.available)
      ? `<p class="no-apps">No apps are assigned to your account yet. Ask your administrator.</p>`
      : "";

    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>LimeHQ</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>
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
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: 'Quicksand', sans-serif;
      background: #f0f4f0;
      margin: 0;
      min-height: 100vh;
    }
    /* Nav */
    .nav {
      background: #fff;
      border-bottom: 1px solid #e4ebe4;
      padding: .75rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .nav-brand {
      font-family: 'Quicksand', sans-serif;
      font-weight: 700;
      font-size: 1.6rem;
      text-decoration: none;
      letter-spacing: -0.3px;
      line-height: 1;
    }
    .lime-part { color: #74b62e; }
    .hq-part   { color: #009344; }
    .q-wrap { position: relative; display: inline-block; }
    .lime-in-q-nav {
      position: absolute;
      top: 53%; left: 51%;
      transform: translate(-50%, -50%);
      width: 15px; height: 15px;
      pointer-events: none;
    }
    .nav-right { display: flex; align-items: center; gap: 1rem; }
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
    /* Main */
    .main {
      max-width: 900px;
      margin: 0 auto;
      padding: 2.5rem 1.5rem 3rem;
    }
    .greeting { font-size: 1.75rem; font-weight: 700; color: #222; margin: 0 0 .3rem; }
    .sub { font-size: 1rem; color: #777; margin: 0 0 2.25rem; font-weight: 500; }
    /* Tile grid */
    .tile-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 1.25rem;
    }
    .tile {
      background: #fff;
      border-radius: 14px;
      box-shadow: 0 2px 20px rgba(0,0,0,.08);
      text-decoration: none;
      color: inherit;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .tile:hover:not(.tile-disabled) {
      transform: translateY(-3px);
      box-shadow: 0 6px 28px rgba(0,0,0,.13);
    }
    .tile-disabled { opacity: .6; cursor: default; }
    .tile-icon {
      background: #009344;
      padding: 1.25rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .tile-icon svg {
      width: 40px;
      height: 40px;
    }
    .tile-body {
      padding: 1rem 1.1rem .6rem;
      flex: 1;
    }
    .tile-name {
      font-size: 1rem;
      font-weight: 700;
      color: #1a2e1a;
      margin-bottom: .3rem;
      display: flex;
      align-items: center;
      gap: .5rem;
      flex-wrap: wrap;
    }
    .tile-desc {
      font-size: .82rem;
      color: #777;
      font-weight: 500;
      line-height: 1.4;
    }
    .tile-arrow {
      padding: .5rem 1.1rem .9rem;
      font-size: 1.1rem;
      color: #74b62e;
      font-weight: 700;
    }
    .tile-disabled .tile-arrow { color: #bbb; }
    .badge-soon {
      font-size: .65rem;
      background: #e8f5e9;
      color: #555;
      border-radius: 20px;
      padding: .15rem .5rem;
      font-weight: 600;
      white-space: nowrap;
    }
    .no-apps {
      color: #888;
      font-size: .95rem;
      text-align: center;
      padding: 3rem;
    }
  </style>
</head>
<body>
  <nav class="nav">
    <a href="/launcher" class="nav-brand"><span class="lime-part">lime</span><span class="hq-part">H</span><span class="hq-part q-wrap">Q<svg class="lime-in-q-nav" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="50" cy="50" r="49" fill="#009344"/><circle cx="50" cy="50" r="43" fill="white"/><circle cx="50" cy="50" r="41" fill="#74b62e"/><line x1="50" y1="9" x2="50" y2="91" stroke="white" stroke-width="3.5" stroke-linecap="round"/><line x1="74" y1="17" x2="26" y2="83" stroke="white" stroke-width="3.5" stroke-linecap="round"/><line x1="89" y1="37" x2="11" y2="63" stroke="white" stroke-width="3.5" stroke-linecap="round"/><line x1="89" y1="63" x2="11" y2="37" stroke="white" stroke-width="3.5" stroke-linecap="round"/><line x1="74" y1="83" x2="26" y2="17" stroke="white" stroke-width="3.5" stroke-linecap="round"/><circle cx="50" cy="50" r="5" fill="white"/></svg></span></a>
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
    <script src="/js/nav.js"></script>
  </nav>
  <main class="main">
    <h1 class="greeting">${greeting}, ${esc(firstName)}.</h1>
    <p class="sub">What would you like to work on today?</p>
    ${noApps}
    <div class="tile-grid">
      ${tileCards}
    </div>
  </main>
</body>
</html>`);
  } catch (err) {
    next(err);
  }
});

// Global error handler — catches ApiError and unexpected errors alike.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ ok: false, error: err.message });
    return;
  }
  logError("Unhandled server error", { error: String(err) });
  res.status(500).json({ ok: false, error: "Internal server error" });
});

app.listen(env.PORT, () => {
  logInfo("limehq server listening", { port: env.PORT });
});
