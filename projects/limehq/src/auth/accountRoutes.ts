import { Router } from "express";
import express from "express";
import { z } from "zod";
import { requireSession } from "./requireSession.js";
import { verifyPassword, hashPassword } from "./password.js";
import { getAppPool } from "../db/pool.js";

export const accountRouter = Router();
// Change Password is a plain HTML <form method="POST"> submission
// (application/x-www-form-urlencoded), not fetch/JSON like login.js.
// Without this, req.body is empty for every field, and zod's default
// error for a missing field ("Required") renders instead of the real
// "Current password is required." message -- same pattern already
// correctly handled in staffRoutes.ts and rolesRoutes.ts, just missing
// here.
accountRouter.use(express.urlencoded({ extended: false }));

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const NAV_WORDMARK = `<span class="lime-part">lime</span><span class="hq-part">H</span><span class="hq-part q-wrap">Q<svg class="lime-in-q-nav" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="50" cy="50" r="49" fill="#009344"/><circle cx="50" cy="50" r="43" fill="white"/><circle cx="50" cy="50" r="41" fill="#74b62e"/><line x1="50" y1="9" x2="50" y2="91" stroke="white" stroke-width="3.5" stroke-linecap="round"/><line x1="74" y1="17" x2="26" y2="83" stroke="white" stroke-width="3.5" stroke-linecap="round"/><line x1="89" y1="37" x2="11" y2="63" stroke="white" stroke-width="3.5" stroke-linecap="round"/><line x1="89" y1="63" x2="11" y2="37" stroke="white" stroke-width="3.5" stroke-linecap="round"/><line x1="74" y1="83" x2="26" y2="17" stroke="white" stroke-width="3.5" stroke-linecap="round"/><circle cx="50" cy="50" r="5" fill="white"/></svg></span>`;

const PAGE_CSS = `
  @font-face { font-family:'Quicksand'; src:url('/fonts/Quicksand-Regular.ttf') format('truetype'); font-weight:400; font-style:normal; }
  @font-face { font-family:'Quicksand'; src:url('/fonts/Quicksand-Medium.ttf') format('truetype'); font-weight:500; font-style:normal; }
  @font-face { font-family:'Quicksand'; src:url('/fonts/Quicksand-Bold.ttf') format('truetype'); font-weight:700; font-style:normal; }
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Quicksand',system-ui,sans-serif; background:#f0f4f0; min-height:100vh; color:#222; }
  .nav { background:#fff; box-shadow:0 1px 4px rgba(0,0,0,0.08); padding:0.75rem 1.5rem; display:flex; align-items:center; justify-content:space-between; }
  .nav-brand { font-family:'Quicksand',sans-serif; font-weight:700; font-size:1.6rem; text-decoration:none; letter-spacing:-0.3px; line-height:1; }
  .lime-part { color:#74b62e; }
  .hq-part   { color:#009344; }
  .q-wrap { position:relative; display:inline-block; }
  .lime-in-q-nav { position:absolute; top:53%; left:51%; transform:translate(-50%,-50%); width:15px; height:15px; pointer-events:none; }
  .nav-right { display:flex; align-items:center; gap:1rem; }
  .user-menu { position:relative; }
  .user-menu-trigger { background:none; border:none; font-family:'Quicksand',sans-serif; font-size:.875rem; font-weight:600; color:#333; cursor:pointer; display:flex; align-items:center; gap:.3rem; padding:.3rem .5rem; border-radius:7px; }
  .user-menu-trigger:hover { background:#f0f4f0; }
  .user-menu-caret { font-size:.65rem; color:#888; }
  .user-menu-dropdown { position:absolute; right:0; top:calc(100% + .4rem); background:#fff; border:1px solid #e0e8e0; border-radius:10px; box-shadow:0 4px 20px rgba(0,0,0,.12); min-width:175px; z-index:100; padding:.3rem; display:none; }
  .user-menu-dropdown.open { display:block; }
  .user-menu-item { display:block; width:100%; text-align:left; padding:.55rem .875rem; border-radius:7px; font-family:'Quicksand',sans-serif; font-size:.875rem; font-weight:600; color:#333; text-decoration:none; background:none; border:none; cursor:pointer; transition:background .1s; }
  .user-menu-item:hover { background:#f0f4f0; color:#333; }
  .user-menu-signout { color:#dc2626; }
  .user-menu-signout:hover { background:#fef2f2; }
  .main { max-width:480px; margin:0 auto; padding:2.5rem 1.5rem 3rem; }
  .page-title { font-size:1.5rem; font-weight:700; color:#222; margin-bottom:1.75rem; }
  .form-group { margin-bottom:1.1rem; }
  label { display:block; font-size:.875rem; font-weight:600; color:#444; margin-bottom:.3rem; }
  input[type="password"] { width:100%; padding:.6rem .875rem; border:1.5px solid #ddd; border-radius:7px; font-family:'Quicksand',sans-serif; font-size:1rem; color:#222; transition:border-color .15s,box-shadow .15s; }
  input:focus { outline:none; border-color:#74b62e; box-shadow:0 0 0 3px rgba(116,182,46,0.15); }
  .btn-primary { background:#74b62e; color:#fff; border:none; border-radius:7px; padding:.65rem 1.5rem; font-family:'Quicksand',sans-serif; font-size:1rem; font-weight:700; cursor:pointer; }
  .btn-primary:hover { background:#67a228; }
  .error-banner { background:#fef2f2; border:1px solid #fca5a5; border-radius:8px; color:#b91c1c; padding:.75rem 1rem; margin-bottom:1.25rem; font-size:.9rem; }
  .success-banner { background:#f0fdf4; border:1px solid #86efac; border-radius:8px; color:#166534; padding:.75rem 1rem; margin-bottom:1.25rem; font-size:.9rem; }
  .hint { font-size:.8rem; color:#888; margin-top:.25rem; }
`;

function renderPage(displayName: string, successMsg: string | null, errorMsg: string | null): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Change Password — LimeHQ</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <nav class="nav">
    <a href="/launcher" class="nav-brand">${NAV_WORDMARK}</a>
    <div class="nav-right">
      <div class="user-menu">
        <button class="user-menu-trigger" id="user-menu-btn" aria-haspopup="true" aria-expanded="false">
          ${esc(displayName)} <span class="user-menu-caret">▾</span>
        </button>
        <div class="user-menu-dropdown" id="user-menu-dropdown">
          <button class="user-menu-item user-menu-signout" id="signout-btn">Sign out</button>
        </div>
      </div>
    </div>
    <script src="/js/nav.js"></script>
  </nav>
  <main class="main">
    <h1 class="page-title">Change Password</h1>
    ${successMsg ? `<div class="success-banner">${esc(successMsg)}</div>` : ""}
    ${errorMsg ? `<div class="error-banner">${esc(errorMsg)}</div>` : ""}
    <form method="POST" action="/account/password">
      <div class="form-group">
        <label for="current_password">Current password</label>
        <input type="password" id="current_password" name="current_password" autocomplete="current-password" required />
      </div>
      <div class="form-group">
        <label for="new_password">New password</label>
        <input type="password" id="new_password" name="new_password" autocomplete="new-password" required />
        <p class="hint">Minimum 8 characters.</p>
      </div>
      <div class="form-group">
        <label for="confirm_password">Confirm new password</label>
        <input type="password" id="confirm_password" name="confirm_password" autocomplete="new-password" required />
      </div>
      <button type="submit" class="btn-primary">Update password</button>
    </form>
  </main>
</body>
</html>`;
}

const changePasswordSchema = z.object({
  current_password: z.string().min(1, "Current password is required."),
  new_password: z.string().min(8, "New password must be at least 8 characters."),
  confirm_password: z.string().min(1, "Please confirm your new password."),
});

accountRouter.get("/account/password", requireSession, async (req, res, next) => {
  try {
    const pool = getAppPool();
    const result = await pool.query<{ display_name: string }>(
      "SELECT display_name FROM users WHERE id = $1",
      [req.user.userId],
    );
    const displayName = result.rows[0]?.display_name ?? req.user.email;
    const success = req.query.success === "1" ? "Password updated successfully." : null;
    res.send(renderPage(displayName, success, null));
  } catch (err) {
    next(err);
  }
});

accountRouter.post("/account/password", requireSession, async (req, res, next) => {
  try {
    const pool = getAppPool();
    const nameResult = await pool.query<{ display_name: string }>(
      "SELECT display_name FROM users WHERE id = $1",
      [req.user.userId],
    );
    const displayName = nameResult.rows[0]?.display_name ?? req.user.email;

    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      const error = parsed.error.errors[0]?.message ?? "Invalid input.";
      res.send(renderPage(displayName, null, error));
      return;
    }

    const { current_password, new_password, confirm_password } = parsed.data;

    if (new_password !== confirm_password) {
      res.send(renderPage(displayName, null, "New passwords don't match."));
      return;
    }

    const userResult = await pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.user.userId],
    );
    const user = userResult.rows[0];
    if (!user) {
      res.send(renderPage(displayName, null, "Account not found."));
      return;
    }

    const currentOk = await verifyPassword(current_password, user.password_hash);
    if (!currentOk) {
      res.send(renderPage(displayName, null, "Current password is incorrect."));
      return;
    }

    const newHash = await hashPassword(new_password);
    await pool.query(
      "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
      [newHash, req.user.userId],
    );

    res.redirect("/account/password?success=1");
  } catch (err) {
    next(err);
  }
});
