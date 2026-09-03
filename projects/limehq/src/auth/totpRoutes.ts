import express, { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import * as OTPAuth from "otpauth";
import qrcode from "qrcode";
import { getAppPool } from "../db/pool.js";
import { encryptSecret, decryptSecret } from "./totpCrypto.js";
import {
  createSessionToken,
  sessionCookieOptions,
  SESSION_COOKIE_NAME,
  createPending2faToken,
  pending2faCookieOptions,
  verifyPending2faToken,
  PENDING_2FA_COOKIE_NAME,
} from "./session.js";
import { logWarn } from "../lib/appLogger.js";

const router = Router();
router.use(express.urlencoded({ extended: false }));

const TOTP_ISSUER = "LimeHQ";
const TOTP_LOCKOUT_THRESHOLD = 5; // matches the existing password-lockout threshold in authRoutes.ts
const TOTP_LOCKOUT_MINUTES = 15; // matches the existing password-lockout duration

function esc(val: string | number | null | undefined): string {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ------------------------------------------------------------------ //
// Pending-2FA guard                                                   //
// ------------------------------------------------------------------ //
// Every route in this file is reachable ONLY by holding a valid
// pending-2FA token — never by a fresh email/password. That token is
// issued in src/auth/authRoutes.ts's POST /auth/login right after the
// password check succeeds.

declare global {
  namespace Express {
    interface Request {
      pending2fa?: { userId: number };
    }
  }
}

async function requirePending2fa(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token: string | undefined = req.cookies?.[PENDING_2FA_COOKIE_NAME];
  if (!token) {
    res.redirect(302, "/");
    return;
  }
  try {
    const payload = await verifyPending2faToken(token);
    req.pending2fa = { userId: payload.userId };
    next();
  } catch {
    res.clearCookie(PENDING_2FA_COOKIE_NAME, { path: "/" });
    res.redirect(302, "/");
  }
}

interface TotpUserRow {
  id: number;
  email: string;
  display_name: string;
  active: boolean;
  totp_secret: string | null;
  totp_enabled_at: Date | null;
  totp_failed_attempts: number;
  locked_until: Date | null;
  session_version: number;
}

async function fetchTotpUser(userId: number): Promise<TotpUserRow | null> {
  const pool = getAppPool();
  const result = await pool.query<TotpUserRow>(
    `SELECT id, email, display_name, active, totp_secret, totp_enabled_at,
            totp_failed_attempts, locked_until, session_version
     FROM users WHERE id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

function buildTotp(email: string, base32Secret: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32Secret),
  });
}

// ------------------------------------------------------------------ //
// Shared page shell — matches the plain server-rendered style already
// used by authRoutes.ts/staffRoutes.ts (no nav bar here: neither page
// runs with a real session yet).
// ------------------------------------------------------------------ //

const PAGE_CSS = `
  @font-face { font-family:'Quicksand'; src:url('/fonts/Quicksand-Regular.ttf') format('truetype'); font-weight:400; font-style:normal; }
  @font-face { font-family:'Quicksand'; src:url('/fonts/Quicksand-Medium.ttf') format('truetype'); font-weight:500; font-style:normal; }
  @font-face { font-family:'Quicksand'; src:url('/fonts/Quicksand-Bold.ttf') format('truetype'); font-weight:700; font-style:normal; }
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Quicksand',system-ui,sans-serif; background:#f0f4f0; min-height:100vh; display:flex; align-items:center; justify-content:center; }
  .card { background:#fff; border-radius:14px; padding:2.5rem 2rem 2rem; width:100%; max-width:420px; box-shadow:0 2px 20px rgba(0,0,0,0.09); }
  h1 { font-size:1.3rem; font-weight:700; color:#222; margin-bottom:0.5rem; text-align:center; }
  .subtitle { font-size:0.875rem; color:#666; text-align:center; margin-bottom:1.5rem; }
  .qr-wrap { display:flex; justify-content:center; margin-bottom:1rem; }
  .qr-wrap img { width:200px; height:200px; border:1px solid #eee; border-radius:8px; }
  .secret-box { background:#f0f4f0; border-radius:8px; padding:0.75rem 1rem; font-family:monospace; font-size:0.9rem; text-align:center; letter-spacing:1px; margin-bottom:1.5rem; word-break:break-all; }
  label { display:block; font-size:0.875rem; font-weight:600; color:#444; margin-bottom:0.3rem; }
  input[type="text"] { width:100%; padding:0.7rem 0.875rem; border:1.5px solid #ddd; border-radius:7px; font-family:'Quicksand',sans-serif; font-size:1.3rem; letter-spacing:3px; text-align:center; color:#222; margin-bottom:1rem; }
  input:focus { outline:none; border-color:#74b62e; box-shadow:0 0 0 3px rgba(116,182,46,0.15); }
  button { width:100%; padding:0.7rem; background:#74b62e; color:#fff; border:none; border-radius:7px; font-family:'Quicksand',sans-serif; font-size:1rem; font-weight:700; cursor:pointer; }
  button:hover { background:#67a228; }
  .error-banner { background:#fef2f2; border:1px solid #fca5a5; border-radius:8px; color:#b91c1c; padding:0.75rem 1rem; margin-bottom:1.25rem; font-size:0.875rem; }
  .hint { font-size:0.8rem; color:#888; margin-top:-0.5rem; margin-bottom:1.25rem; text-align:center; }
  .forgot-link { display:block; text-align:center; font-size:0.85rem; color:#009344; text-decoration:none; margin-top:1.25rem; }
  .forgot-link:hover { text-decoration:underline; }
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

// ------------------------------------------------------------------ //
// GET /account/totp/setup                                             //
// ------------------------------------------------------------------ //
// FIXED [today]: this used to generate and store a brand-new secret on
// EVERY GET, unconditionally — the idea was that this makes an abandoned/
// orphaned unconfirmed enrollment safe to walk away from (reloading this
// page overwrites whatever unconfirmed secret was sitting there before, so
// nothing lingers). In practice it meant a page reload, a second tab, or
// browser back/forward AFTER scanning the QR code silently swapped the
// stored secret out from under an authenticator app that had already
// enrolled the old one — every code that app generates from then on checks
// against a secret it was never given, and fails with no explanation. Real
// case: Dana Sampson, 2026-09-02, reset by Jason via the admin "Reset 2FA"
// action, then locked out of her own fresh enrollment this exact way.
//
// Now a secret is only generated once — the first GET after totp_secret is
// null (a fresh account, or right after an admin reset clears it). Every
// later GET (reload, second tab, back/forward) reuses that same unconfirmed
// secret instead of rotating it, so the QR/manual code shown always matches
// what POST will check against, until either it's confirmed
// (totp_enabled_at gets set) or an admin resets it again (which nulls
// totp_secret and starts this over legitimately).
router.get("/account/totp/setup", requirePending2fa, async (req, res, next) => {
  try {
    const user = await fetchTotpUser(req.pending2fa!.userId);
    if (!user || !user.active) {
      res.clearCookie(PENDING_2FA_COOKIE_NAME, { path: "/" });
      res.redirect(302, "/");
      return;
    }
    if (user.totp_enabled_at) {
      // Already enrolled — this page isn't relevant, send them to code entry.
      res.redirect(302, "/auth/totp");
      return;
    }

    let base32Secret: string;
    if (user.totp_secret) {
      base32Secret = decryptSecret(user.totp_secret);
    } else {
      const secret = new OTPAuth.Secret();
      base32Secret = secret.base32;
      await getAppPool().query(
        `UPDATE users SET totp_secret = $1, updated_at = now() WHERE id = $2`,
        [encryptSecret(base32Secret), user.id],
      );
    }

    const totp = buildTotp(user.email, base32Secret);
    const qrDataUri = await qrcode.toDataURL(totp.toString());

    res.send(page("Set Up Authenticator", setupForm(qrDataUri, base32Secret, null)));
  } catch (err) {
    next(err);
  }
});

function setupForm(qrDataUri: string, base32Secret: string, errorMsg: string | null): string {
  return `
    <h1>Set Up Two-Factor Authentication</h1>
    <p class="subtitle">Scan this code with your authenticator app (e.g. Google Authenticator, Authy), then enter the 6-digit code it shows.</p>
    ${errorMsg ? `<div class="error-banner">${esc(errorMsg)}</div>` : ""}
    <div class="qr-wrap"><img src="${qrDataUri}" alt="QR code for authenticator app"/></div>
    <div class="secret-box">${esc(base32Secret)}</div>
    <p class="hint">Can't scan? Enter this code manually instead.</p>
    <form method="POST" action="/account/totp/setup">
      <label for="code">6-digit code</label>
      <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" required autofocus/>
      <button type="submit">Confirm &amp; Enable</button>
    </form>`;
}

// ------------------------------------------------------------------ //
// POST /account/totp/setup                                            //
// ------------------------------------------------------------------ //

router.post("/account/totp/setup", requirePending2fa, async (req, res, next) => {
  try {
    const user = await fetchTotpUser(req.pending2fa!.userId);
    if (!user || !user.active) {
      res.clearCookie(PENDING_2FA_COOKIE_NAME, { path: "/" });
      res.redirect(302, "/");
      return;
    }
    if (user.totp_enabled_at) {
      res.redirect(302, "/auth/totp");
      return;
    }
    if (!user.totp_secret) {
      // No secret on file (shouldn't normally happen — GET always sets one
      // first) — send them back to GET to generate a fresh one.
      res.redirect(302, "/account/totp/setup");
      return;
    }

    const code = String((req.body as Record<string, string>).code ?? "").trim();
    const base32Secret = decryptSecret(user.totp_secret);
    const totp = buildTotp(user.email, base32Secret);
    const delta = totp.validate({ token: code, window: 1 });

    if (delta === null) {
      // Wrong code — re-render the SAME secret (no regeneration on a failed
      // attempt), with an error banner.
      const qrDataUri = await qrcode.toDataURL(totp.toString());
      res.status(400).send(page("Set Up Authenticator", setupForm(qrDataUri, base32Secret, "That code didn't match. Try again.")));
      return;
    }

    const now = Date.now();
    await getAppPool().query(
      `UPDATE users SET totp_enabled_at = now(), updated_at = now() WHERE id = $1`,
      [user.id],
    );

    const sessionToken = await createSessionToken({
      userId: user.id,
      email: user.email,
      authenticatedAt: now,
      sessionVersion: user.session_version,
      lastActivityAt: now,
    });
    res.clearCookie(PENDING_2FA_COOKIE_NAME, { path: "/" });
    res.cookie(SESSION_COOKIE_NAME, sessionToken, sessionCookieOptions());
    res.redirect(302, "/launcher");
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ //
// GET /auth/totp                                                      //
// ------------------------------------------------------------------ //

router.get("/auth/totp", requirePending2fa, async (req, res, next) => {
  try {
    const user = await fetchTotpUser(req.pending2fa!.userId);
    if (!user || !user.active) {
      res.clearCookie(PENDING_2FA_COOKIE_NAME, { path: "/" });
      res.redirect(302, "/");
      return;
    }
    if (!user.totp_enabled_at) {
      res.redirect(302, "/account/totp/setup");
      return;
    }

    const locked = user.locked_until && user.locked_until > new Date();
    res.send(page("Enter Code", totpForm(locked ? "Account temporarily locked due to too many failed attempts." : null)));
  } catch (err) {
    next(err);
  }
});

function totpForm(errorMsg: string | null): string {
  return `
    <h1>Enter Your Code</h1>
    <p class="subtitle">Enter the 6-digit code from your authenticator app.</p>
    ${errorMsg ? `<div class="error-banner">${esc(errorMsg)}</div>` : ""}
    <form method="POST" action="/auth/totp">
      <label for="code">6-digit code</label>
      <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" required autofocus/>
      <button type="submit">Verify</button>
    </form>
    <a href="/auth/recovery/request" class="forgot-link">Forgot your authenticator?</a>`;
}

// ------------------------------------------------------------------ //
// POST /auth/totp                                                     //
// ------------------------------------------------------------------ //
// Same generic error either way (wrong code, locked, malformed input) —
// mirrors the existing login page's "Invalid email or password" convention.
// This route never looks the user up by email/password — only by the
// pending-2FA token, which is only ever issued after a password already
// checked out in authRoutes.ts.

const GENERIC_ERROR = "That code didn't work. Please try again.";

router.post("/auth/totp", requirePending2fa, async (req, res, next) => {
  try {
    const user = await fetchTotpUser(req.pending2fa!.userId);
    if (!user || !user.active) {
      res.clearCookie(PENDING_2FA_COOKIE_NAME, { path: "/" });
      res.redirect(302, "/");
      return;
    }
    if (!user.totp_enabled_at || !user.totp_secret) {
      res.redirect(302, "/account/totp/setup");
      return;
    }

    if (user.locked_until && user.locked_until > new Date()) {
      res.status(429).send(page("Enter Code", totpForm("Account temporarily locked due to too many failed attempts.")));
      return;
    }

    const code = String((req.body as Record<string, string>).code ?? "").trim();
    const base32Secret = decryptSecret(user.totp_secret);
    const totp = buildTotp(user.email, base32Secret);
    const delta = totp.validate({ token: code, window: 1 });

    if (delta === null) {
      const newAttempts = user.totp_failed_attempts + 1;
      const lockUntil =
        newAttempts >= TOTP_LOCKOUT_THRESHOLD
          ? new Date(Date.now() + TOTP_LOCKOUT_MINUTES * 60 * 1000)
          : null;

      await getAppPool().query(
        `UPDATE users
         SET totp_failed_attempts = $1,
             locked_until         = COALESCE($2, locked_until),
             updated_at           = now()
         WHERE id = $3`,
        [newAttempts, lockUntil, user.id],
      );
      logWarn("totp: bad code", { userId: user.id, attempts: newAttempts });
      res.status(401).send(page("Enter Code", totpForm(GENERIC_ERROR)));
      return;
    }

    const now = Date.now();
    await getAppPool().query(
      `UPDATE users
       SET totp_failed_attempts = 0,
           locked_until         = NULL,
           updated_at           = now()
       WHERE id = $1`,
      [user.id],
    );

    const sessionToken = await createSessionToken({
      userId: user.id,
      email: user.email,
      authenticatedAt: now,
      sessionVersion: user.session_version,
      lastActivityAt: now,
    });
    res.clearCookie(PENDING_2FA_COOKIE_NAME, { path: "/" });
    res.cookie(SESSION_COOKIE_NAME, sessionToken, sessionCookieOptions());
    res.redirect(302, "/launcher");
  } catch (err) {
    next(err);
  }
});

// Re-exported so recoveryRoutes.ts can reuse the exact same pending-2FA
// issuance helper without duplicating cookie-setting logic.
export async function issuePending2faCookie(res: Response, userId: number): Promise<void> {
  const token = await createPending2faToken(userId);
  res.cookie(PENDING_2FA_COOKIE_NAME, token, pending2faCookieOptions());
}

export { router as totpRouter };
