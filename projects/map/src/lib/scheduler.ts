// Decides whether "now" is the intended daily sync run time, in
// America/New_York wall-clock time. Simpler than late-rent-notices'
// scheduler.ts: Map's sync runs every day including weekends/holidays
// (properties/leases/tenants don't stop changing on a Saturday, and there's
// no legal-deadline business-day logic here) — no rollForwardToBusinessDay
// needed.
//
// Same DST lesson learned from late-rent-notices (confirmed live on the
// production VPS 2026-07-17): crontab's CRON_TZ= prefix is not reliably
// honored by the cron implementation installed there. Cron should invoke
// this script on a plain UTC schedule (e.g. hourly, or every 15 minutes)
// and this function decides whether it's really the scheduled moment —
// America/New_York's UTC offset is always a whole number of hours, so a
// fixed local time always lands on a clean UTC boundary too.
function getEasternLocalHourMinute(instant: Date): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(instant);
  const hourRaw = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // hour12: false can format midnight as "24" in some Node/ICU builds
  // instead of "0" — normalize so callers never have to special-case it.
  const hour = hourRaw === 24 ? 0 : hourRaw;
  return { hour, minute };
}

export function isScheduledRunTime(now: Date, hourLocal: number, minuteLocal: number): boolean {
  const { hour, minute } = getEasternLocalHourMinute(now);
  return hour === hourLocal && minute === minuteLocal;
}

// Today's intended run instant (America/New_York, DST-aware), used as
// sync_runs.scheduled_for. Runs every calendar day, no business-day
// rollforward.
export function computeScheduledRunTime(now: Date, hourLocal: number): Date {
  const offsetHours = getEasternUtcOffsetHours(now);
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourLocal - offsetHours, 0, 0)
  );
}

// Resolves the actual UTC offset America/New_York is observing at a given
// instant (-5 in winter/EST, -4 in summer/EDT), via Intl's timeZoneName
// rather than a hardcoded table that would need manual DST correction
// twice a year.
function getEasternUtcOffsetHours(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(instant);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const match = tzName.match(/GMT([+-]\d+)/);
  return match ? Number(match[1]) : -5;
}
