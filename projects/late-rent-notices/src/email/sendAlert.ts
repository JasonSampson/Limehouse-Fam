import { loadEnv } from "../config/env.js";
import { logInfo, logError } from "../lib/appLogger.js";

// Job-failure alerting. Posts to a Microsoft Teams channel via an incoming
// webhook — Jason's explicit choice, kept independent of the Microsoft
// Graph mailbox used for tenant notice emails (src/email/graphMailer.ts),
// so a Graph outage can't also silence the alert telling him Graph is down.
//
// Renamed from the earlier "sendAlertEmail" stub: a function called
// "...Email" that doesn't send email is its own kind of bug — misleading
// names cause real mistakes later.
export interface AlertMessage {
  to: string; // kept for the audit-trail/log context, not used as a Teams recipient
  subject: string;
  body: string;
}

export async function sendAlert(alert: AlertMessage): Promise<void> {
  const env = loadEnv();

  // Shadow mode: same no-op-and-log pattern as sendNotice.ts's Step 3 — log
  // that this WOULD have been posted to Teams, but do not actually call the
  // webhook. This is the default, required starting state — there is
  // deliberately no flag to skip it from inside this function.
  if (env.SHADOW_MODE) {
    logInfo("shadow mode: Teams alert suppressed", { jobName: alert.subject });
    return;
  }

  // Teams "MessageCard" payload — the format the classic incoming-webhook
  // connector expects. themeColor red signals "this needs attention" at a
  // glance in the channel.
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
    // The alert path itself failing is the worst case here — there's no
    // further fallback channel configured. Log loudly to stderr (console
    // output on the server is the last line of defense) rather than
    // swallowing this silently.
    logError("FAILED to post alert to Teams — this alert did not reach anyone", {
      error: err instanceof Error ? err.message : String(err),
    });
    console.error(`\n=== ALERT DELIVERY FAILED ===\nIntended for: ${alert.to}\n${alert.subject}\n\n${alert.body}\n===\n`);
    throw err;
  }
}
