import crypto from "node:crypto";
import express, { Router } from "express";
import { getAppPool } from "../db/pool.js";
import { verifyPassword } from "./password.js";
import { issuePending2faCookie } from "./totpRoutes.js";
import { sendRecoveryEmail } from "../email/graphMailer.js";
import { logWarn, logError } from "../lib/appLogger.js";

const router = Router();
router.use(express.urlencoded({ extended: false }));

function esc(val: string | number | null | undefined): string {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const PAGE_CSS = `
  @font-face { font-family:'Quicksand'; src:url('/fonts/Quicksand-Regular.ttf') format('truetype'); font-weight:400; font-style:normal; }
  @font-face { font-family:'Quicksand'; src:url('/fonts/Quicksand-Medium.ttf') format('truetype'); font-weight:500; font-style:normal; }
  @font-face { font-family:'Quicksand'; src:url('/fonts/Quicksand-Bold.ttf') format('truetype'); font-weight:700; font-style:normal; }
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Quicksand',system-ui,sans-serif; background:#f0f4f0; min-height:100vh; display:flex; align-items:center; justify-content:center; }
  .card { background:#fff; border-radius:14px; padding:2.5rem 2rem 2rem; width:100%; max-width:420px; box-shadow:0 2px 20px rgba(0,0,0,0.09); }
  h1 { font-size:1.3rem; font-weight:700; color:#222; margin-bottom:0.5rem; text-align:center; }
  .subtitle { font-size:0.875rem; color:#666; text-align:center; margin-bottom:1.5rem; }
  label { display:block; font-size:0.875rem; font-weight:600; color:#444; margin-bottom:0.3rem; }
  input[type="email"], input[type="password"] { width:100%; padding:0.7rem 0.875rem; border:1.5px solid #ddd; border-radius:7px; font-family:'Quicksand',sans-serif; font-size:1rem; color:#222; margin-bottom:1rem; }
  input:focus { outline:none; border-color:#74b62e; box-shadow:0 0 0 3px rgba(116,182,46,0.15); }
  button { width:100%; padding:0.7rem; background:#74b62e; color:#fff; border:none; border-radius:7px; font-family:'Quicksand',sans-serif; font-size:1rem; font-weight:700; cursor:pointer; }
  button:hover { background:#67a228; }
  .error-banner { background:#fef2f2; border:1px solid #fca5a5; border-radius:8px; color:#b91c1c; padding:0.75rem 1rem; margin-bottom:1.25rem; font-size:0.875rem; }
  .info-box { background:#f0f4f0; border-radius:8px; color:#444; padding:0.9rem 1rem; font-size:0.875rem; line-height:1.5; }
`;

function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${esc(title)} — LimeHQ</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="card">${bodyHtml}</div>
</body>
</html>`;
}

// The generic, non-enumerating response shown regardless of whether the
// email matched an eligible (Owner, active) account — matches the existing
// login route's convention of never revealing whether an address exists.
const GENERIC_CONFIRMATION_HTML = `
  <h1>Check Your Email</h1>
  <p class="subtitle"></p>
  <div class="info-box">If that account exists, we sent a recovery link. It expires in 15 minutes.</div>`;

// ------------------------------------------------------------------ //
// Rate limiting                                                       //
// ------------------------------------------------------------------ //
// No rate-limiting infrastructure exists anywhere else in this codebase
// yet, so a plain in-process Map is the simplest thing that satisfies the
// requirement (max 3/hour per email, max 5/hour per IP) without adding a
// new dependency or a new DB table. Tradeoff, noted here rather than
// discovered later: this resets on every server restart/redeploy and does
// NOT share state across multiple server instances — fine for LimeHQ's
// current single-instance deployment, but would need a DB-backed or
// Redis-backed counter if that ever changes.
const HOUR_MS = 60 * 60 * 1000;
const perEmailRequests = new Map<string, number[]>();
const perIpRequests = new Map<string, number[]>();

function isRateLimited(map: Map<string, number[]>, key: string, limit: number): boolean {
  const now = Date.now();
  const timestamps = (map.get(key) ?? []).filter((t) => now - t < HOUR_MS);
  if (timestamps.length >= limit) {
    map.set(key, timestamps);
    return true;
  }
  timestamps.push(now);
  map.set(key, timestamps);
  return false;
}

// Lazy, occasional cleanup so these Maps don't grow forever — piggybacks on
// request traffic rather than running a separate timer.
let lastCleanup = Date.now();
function maybeCleanup(): void {
  const now = Date.now();
  if (now - lastCleanup < HOUR_MS) return;
  lastCleanup = now;
  for (const [key, timestamps] of perEmailRequests) {
    const kept = timestamps.filter((t) => now - t < HOUR_MS);
    if (kept.length === 0) perEmailRequests.delete(key);
    else perEmailRequests.set(key, kept);
  }
  for (const [key, timestamps] of perIpRequests) {
    const kept = timestamps.filter((t) => now - t < HOUR_MS);
    if (kept.length === 0) perIpRequests.delete(key);
    else perIpRequests.set(key, kept);
  }
}

// ------------------------------------------------------------------ //
// GET /auth/recovery/request                                          //
// ------------------------------------------------------------------ //
// Reached via the "Forgot your authenticator?" link on /auth/totp — shown
// to every user on that page (per the reviewed design), since the
// POST handler below silently no-ops for anyone who isn't the Owner.

router.get("/auth/recovery/request", (_req, res) => {
  res.send(
    page(
      "Account Recovery",
      `
    <h1>Account Recovery</h1>
    <p class="subtitle">Enter your account email and we'll send a recovery link if eligible.</p>
    <form method="POST" action="/auth/recovery/request">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" autocomplete="username" required autofocus/>
      <button type="submit">Send Recovery Link</button>
    </form>`,
    ),
  );
});

// ------------------------------------------------------------------ //
// POST /auth/recovery/request                                         //
// ------------------------------------------------------------------ //
// ALWAYS renders the same generic confirmation, regardless of whether the
// email matched anything, whether the account is Owner, or whether a rate
// limit was hit — non-enumeration and "fail silently from the caller's
// perspective" both require this. (Rendered as a plain HTML page here
// rather than a JSON body: this route is reached from a plain browser link
// with no JS on the page, matching this codebase's convention for
// user-facing, non-fetch flows — see staffRoutes.ts/accountRoutes.ts.)

router.post("/auth/recovery/request", async (req, res, next) => {
  try {
    maybeCleanup();
    const email = String((req.body as Record<string, string>).email ?? "")
      .trim()
      .toLowerCase();
    const requestIp = req.ip ?? "unknown";

    if (!email) {
      res.send(page("Account Recovery", GENERIC_CONFIRMATION_HTML));
      return;
    }

    const emailLimited = isRateLimited(perEmailRequests, email, 3);
    const ipLimited = isRateLimited(perIpRequests, requestIp, 5);

    if (emailLimited || ipLimited) {
      res.send(page("Account Recovery", GENERIC_CONFIRMATION_HTML));
      return;
    }

    const pool = getAppPool();
    const userResult = await pool.query<{
      id: number;
      email: string;
      active: boolean;
      system_role_key: string | null;
    }>(
      `SELECT u.id, u.email, u.active, rt.system_role_key
       FROM users u JOIN role_templates rt ON rt.id = u.role_template_id
       WHERE u.email = $1`,
      [email],
    );
    const user = userResult.rows[0];

    if (user && user.active && user.system_role_key === "owner") {
      try {
        const token = crypto.randomBytes(32).toString("base64url");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // Only one live token at a time — delete any prior unused token
          // for this user before inserting the new one.
          await client.query(
            `DELETE FROM owner_recovery_tokens WHERE user_id = $1 AND used_at IS NULL`,
            [user.id],
          );
          await client.query(
            `INSERT INTO owner_recovery_tokens (user_id, token_hash, expires_at, requested_ip)
             VALUES ($1, $2, now() + interval '15 minutes', $3)`,
            [user.id, tokenHash, requestIp],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }

        const recoveryUrl = `${req.protocol}://${req.get("host")}/auth/recovery/consume?token=${token}`;
        await sendRecoveryEmail(user.email, recoveryUrl);
      } catch (err) {
        // Never let an email/DB failure leak through as a different
        // response shape — log it, still show the generic confirmation.
        logError("recovery request: failed to issue/send recovery token", {
          error: String(err),
        });
      }
    }

    res.send(page("Account Recovery", GENERIC_CONFIRMATION_HTML));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// GET /auth/recovery/consume?token=...                                //
// ------------------------------------------------------------------ //
// Confirm-then-act: this GET never validates or consumes the token by
// itself (a prefetched/forwarded link alone does nothing) — it only
// renders a form. The token only does anything once POSTed below along
// with the account's current password.

router.get("/auth/recovery/consume", (req, res) => {
  const token = typeof req.query["token"] === "string" ? req.query["token"] : "";
  res.send(
    page(
      "Account Recovery",
      `
    <h1>Confirm Recovery</h1>
    <p class="subtitle">Enter your current password to continue. This will reset your two-factor authentication — you'll set it up again right after.</p>
    <form method="POST" action="/auth/recovery/consume">
      <input type="hidden" name="token" value="${esc(token)}"/>
      <label for="password">Current password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required autofocus/>
      <button type="submit">Continue</button>
    </form>`,
    ),
  );
});

// ------------------------------------------------------------------ //
// POST /auth/recovery/consume                                         //
// ------------------------------------------------------------------ //

router.post("/auth/recovery/consume", async (req, res, next) => {
  try {
    const body = req.body as Record<string, string>;
    const token = String(body.token ?? "");
    const password = String(body.password ?? "");

    if (!token || !password) {
      res.status(401).send(page("Account Recovery", recoveryFailedHtml()));
      return;
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const pool = getAppPool();

    const tokenResult = await pool.query<{
      id: number;
      user_id: number;
      password_hash: string;
      session_version: number;
    }>(
      `SELECT t.id, t.user_id, u.password_hash, u.session_version
       FROM owner_recovery_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
      [tokenHash],
    );
    const row = tokenResult.rows[0];

    if (!row) {
      logWarn("recovery consume: invalid, expired, or already-used token", {});
      res.status(401).send(page("Account Recovery", recoveryFailedHtml()));
      return;
    }

    const passwordOk = await verifyPassword(password, row.password_hash);
    if (!passwordOk) {
      logWarn("recovery consume: incorrect password", { userId: row.user_id });
      res.status(401).send(page("Account Recovery", recoveryFailedHtml()));
      return;
    }

    // Atomically mark used — WHERE used_at IS NULL prevents a race where
    // two concurrent requests both pass the earlier SELECT and both try to
    // consume the same token.
    const consumeResult = await pool.query(
      `UPDATE owner_recovery_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL`,
      [row.id],
    );
    if (consumeResult.rowCount === 0) {
      logWarn("recovery consume: token already consumed by a concurrent request", {
        userId: row.user_id,
      });
      res.status(401).send(page("Account Recovery", recoveryFailedHtml()));
      return;
    }

    // Fully reset 2FA and bump session_version so any already-issued
    // session for this user is invalidated immediately (requireSession.ts).
    await pool.query(
      `UPDATE users
       SET totp_secret     = NULL,
           totp_enabled_at = NULL,
           totp_failed_attempts = 0,
           locked_until     = NULL,
           session_version  = session_version + 1,
           updated_at       = now()
       WHERE id = $1`,
      [row.user_id],
    );

    // Recovery always ends in mandatory re-enrollment, never a direct
    // login — issue a pending-2FA token, not a real session.
    await issuePending2faCookie(res, row.user_id);
    res.redirect(302, "/account/totp/setup");
  } catch (err) {
    next(err);
  }
});

function recoveryFailedHtml(): string {
  return `
    <h1>Recovery Link Invalid</h1>
    <div class="error-banner">This recovery link is invalid, expired, or your password didn't match. Request a new link to try again.</div>
    <a href="/auth/recovery/request" style="display:block;text-align:center;font-size:0.875rem;color:#009344;text-decoration:none">Request a new recovery link</a>`;
}

export { router as recoveryRouter };
