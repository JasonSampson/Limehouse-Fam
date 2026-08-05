import { rollForwardToBusinessDay, getEasternUtcOffsetHours } from "./businessCalendar.js";

// Reads the current wall-clock hour/minute in America/New_York for a given
// instant, DST included (same Intl-based approach as
// getEasternUtcOffsetHours, kept here rather than added to businessCalendar
// since it's about "what time is it right now locally," not calendar-day
// arithmetic).
export function getEasternLocalHourMinute(instant: Date): { hour: number; minute: number } {
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

// Confirmed on the production VPS 2026-07-17: crontab's `CRON_TZ=` prefix
// is NOT honored by the cron implementation actually installed there (the
// server's own timezone is Etc/UTC, and jobs scheduled "10:00/10:15/10:30"
// under CRON_TZ=America/New_York fired at 10:00/10:15/10:30 UTC instead —
// 4 hours early during EDT). Rather than depend on crontab's timezone
// handling working at all (fragile across cron implementations, and a
// fixed-offset UTC crontab line would itself need manual correction twice a
// year for DST), the job scripts decide for themselves whether "now" is
// the intended run time. Cron should invoke every 15 minutes on a plain UTC
// schedule (e.g. `*/15 * * * *`, no CRON_TZ) — since America/New_York's UTC
// offset is always a whole number of hours, 10:00/10:15/10:30 Eastern
// always lands exactly on a UTC :00/:15/:30 boundary too, so this check
// still fires at the right moment year-round with zero manual DST
// correction on the server.
export function isScheduledRunTime(now: Date, hourLocal: number, minuteLocal: number): boolean {
  const { hour, minute } = getEasternLocalHourMinute(now);
  return hour === hourLocal && minute === minuteLocal;
}

// Computes today's intended 10:00 America/New_York run instant for the
// daily job, rolled forward to the next business day if today is a
// weekend/holiday. DST-aware (Jason confirmed): resolves the actual
// UTC offset Virginia is observing on that business day — UTC-5 in winter
// (EST), UTC-4 in summer (EDT) — so the job consistently runs at 10am local
// wall-clock time year-round instead of drifting to 9am local for the ~8
// months EDT is in effect.
export function computeScheduledRunTime(now: Date, hourLocal: number): Date {
  const businessDay = rollForwardToBusinessDay(now);
  // Use noon UTC on the target calendar day (not midnight) to look up the
  // offset, so we're never accidentally asking about the offset on the
  // wrong side of a UTC-midnight boundary for a date that's meant to
  // represent that calendar day in Eastern time.
  const noonUtcOnTargetDay = new Date(
    Date.UTC(businessDay.getUTCFullYear(), businessDay.getUTCMonth(), businessDay.getUTCDate(), 12, 0, 0)
  );
  const offsetHours = getEasternUtcOffsetHours(noonUtcOnTargetDay);
  const scheduled = new Date(
    Date.UTC(
      businessDay.getUTCFullYear(),
      businessDay.getUTCMonth(),
      businessDay.getUTCDate(),
      hourLocal - offsetHours, // e.g. 10 - (-5) = 15 UTC in winter, 10 - (-4) = 14 UTC in summer
      0,
      0
    )
  );
  return scheduled;
}
