import { loadEnv } from "../config/env.js";

// Sends mail via Microsoft Graph's sendMail API using application
// permissions (client-credentials flow) against a shared compliance
// mailbox — NOT per-PM delegated send. This means the "From" address on
// every notice is the shared mailbox (e.g. compliance@limehousepm.com),
// which is both simpler to operate and avoids needing delegated-send
// consent from each individual PM's mailbox.
//
// Requires a Graph app registration with Mail.Send (Application) permission,
// admin-consented, scoped via application access policy to only the
// compliance mailbox (not "any mailbox in the tenant") — Scotty/Sentinel
// should confirm this scoping is configured in Entra before go-live.
let cachedToken: { value: string; expiresAt: number } | undefined;

async function getGraphAccessToken(): Promise<string> {
  const env = loadEnv();
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }

  const tokenUrl = `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: env.GRAPH_CLIENT_ID,
    client_secret: env.GRAPH_CLIENT_SECRET,
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

export interface GraphRecipient {
  email: string;
}

export interface GraphSendMailRequest {
  subject: string;
  bodyHtml: string;
  toRecipients: GraphRecipient[];
  ccRecipients: GraphRecipient[];
}

export interface GraphSendResult {
  success: boolean;
  errorMessage?: string;
}

// Convenience wrapper for one-recipient, no-cc business notifications (PM
// reminders, escalation nudges) — these are real emails to a specific
// person's inbox, NOT job-failure ops alerts (see src/email/sendAlert.ts,
// which is Teams-only and reserved for "something is broken," not "please
// take this business action").
export async function sendPmNotificationEmail(
  toEmail: string,
  subject: string,
  bodyText: string
): Promise<GraphSendResult> {
  return sendGraphMail({
    subject,
    bodyHtml: bodyText.replace(/\n/g, "<br>"),
    toRecipients: [{ email: toEmail }],
    ccRecipients: [],
  });
}

export async function sendGraphMail(req: GraphSendMailRequest): Promise<GraphSendResult> {
  const env = loadEnv();
  try {
    const token = await getGraphAccessToken();
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.GRAPH_SENDER_MAILBOX)}/sendMail`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: req.subject,
            body: { contentType: "HTML", content: req.bodyHtml },
            toRecipients: req.toRecipients.map((r) => ({ emailAddress: { address: r.email } })),
            ccRecipients: req.ccRecipients.map((r) => ({ emailAddress: { address: r.email } })),
          },
          saveToSentItems: true,
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>");
      return { success: false, errorMessage: `Graph sendMail failed: ${res.status} ${body}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, errorMessage: err instanceof Error ? err.message : String(err) };
  }
}
