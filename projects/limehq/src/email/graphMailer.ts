import { loadEnv } from "../config/env.js";
import { logInfo, logWarn, logError } from "../lib/appLogger.js";

// Sends the Owner's TOTP-recovery email (src/auth/recoveryRoutes.ts) via
// Microsoft Graph's sendMail API using application permissions
// (client-credentials flow) — same pattern as the late-rent-notices
// project's src/email/graphMailer.ts, copied rather than imported since
// that's a separate deployable app, and adapted for a single-recipient,
// plain-text recovery email instead of HTML compliance notices.
//
// This targets a DIFFERENT Entra app registration / mailbox than that
// project's (see env.ts's GRAPH_* comment) — do not reuse those credentials
// here. Requires a real Entra app registration with Mail.Send (Application,
// admin-consented) before this can actually send in production; that
// registration is a manual Scotty/Jason step this codebase cannot complete
// on its own (the sibling late-rent-notices integration is currently
// blocked on the same kind of setup, per its .env CHANGE_ME placeholders).
let cachedToken: { value: string; expiresAt: number } | undefined;

function graphConfigured(): boolean {
  const env = loadEnv();
  return Boolean(
    env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET && env.GRAPH_SENDER_MAILBOX,
  );
}

async function getGraphAccessToken(): Promise<string> {
  const env = loadEnv();
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }

  const tokenUrl = `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID as string,
    client_secret: env.GRAPH_CLIENT_SECRET as string,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Failed to get Graph access token: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

async function sendGraphMail(toEmail: string, subject: string, bodyText: string): Promise<void> {
  const env = loadEnv();
  const token = await getGraphAccessToken();
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.GRAPH_SENDER_MAILBOX as string)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "Text", content: bodyText },
          toRecipients: [{ emailAddress: { address: toEmail } }],
        },
        saveToSentItems: true,
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`Graph sendMail failed: ${res.status} ${body}`);
  }
}

// Plain text, fixed subject, no HTML/branding — per the reviewed recovery
// design (src/auth/recoveryRoutes.ts), so the email itself can't be mimicked
// by a phishing template that "looks more official."
const SUBJECT = "LimeHQ account recovery requested";

function buildBody(recoveryUrl: string): string {
  return [
    "A LimeHQ account recovery was requested for this email address.",
    "",
    `Link: ${recoveryUrl}`,
    "",
    "This link expires in 15 minutes and works once.",
    "",
    "We will only ever send you a plain link like this one. We will never ask you to reply with a code, call a number, or enter your password anywhere except directly on limehq.net.",
    "",
    "If you did not request this, you can ignore this email.",
  ].join("\n");
}

export async function sendRecoveryEmail(toEmail: string, recoveryUrl: string): Promise<void> {
  const body = buildBody(recoveryUrl);

  if (!graphConfigured()) {
    // Dev-only fallback: this codebase's other email-sending integration
    // (late-rent-notices' graphMailer.ts) is currently unconfigured too, so
    // there's no working example to lean on yet. In development we log the
    // link so the flow can be exercised end-to-end without a live Entra app
    // registration; in production this is a hard failure — recovery must
    // not silently no-op there.
    if (loadEnv().NODE_ENV === "production") {
      logError("sendRecoveryEmail: Graph mail is not configured in production", {});
      throw new Error(
        "TOTP recovery email is not configured: set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, " +
          "GRAPH_CLIENT_SECRET, and GRAPH_SENDER_MAILBOX before this can send in production.",
      );
    }
    logWarn("sendRecoveryEmail: Graph mail not configured, logging recovery link instead (dev only)", {});
    // eslint-disable-next-line no-console
    console.log(`[dev] Recovery email for ${toEmail}:\n${body}`);
    return;
  }

  await sendGraphMail(toEmail, SUBJECT, body);
  logInfo("sendRecoveryEmail: recovery email sent", {});
}
