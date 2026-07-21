import { loadEnv } from "../config/env.js";
import { logInfo, logError } from "../lib/appLogger.js";

// Job-failure alerting for Map's sync job. Reuses the exact same pattern
// late-rent-notices already proved out (src/email/sendAlert.ts): post to a
// Microsoft Teams channel via an incoming webhook. Can be the same Teams
// webhook/channel as late-rent-notices or a separate one — Jason's call,
// configured independently via this project's own TEAMS_ALERT_WEBHOOK_URL.
//
// No shadow-mode flag here (unlike late-rent-notices) — Map never sends
// anything to a tenant/owner/vendor, so there's no "would have sent"
// concept to suppress. An alert about a broken sync job should always
// actually post.
export interface AlertMessage {
  to: string; // kept for the audit-trail/log context, not used as a Teams recipient
  subject: string;
  body: string;
}

export async function sendAlert(alert: AlertMessage): Promise<void> {
  const env = loadEnv();

  const payload = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    summary: alert.subject,
    themeColor: "FF0000",
    title: alert.subject,
    text: alert.body.replace(/\n/g, "\n\n"), // Teams renders single \n as no break
  };

  try {
    const res = await fetch(env.TEAMS_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(`Teams webhook returned ${res.status}: ${text}`);
    }
    logInfo("alert posted to Teams", { jobName: alert.subject });
  } catch (err) {
    logError("FAILED to post alert to Teams — this alert did not reach anyone", {
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(`\n=== ALERT DELIVERY FAILED ===\nIntended for: ${alert.to}\n${alert.subject}\n\n${alert.body}\n===\n`);
    throw err;
  }
}
