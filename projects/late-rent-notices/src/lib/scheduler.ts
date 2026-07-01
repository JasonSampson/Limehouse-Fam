import { rollForwardToBusinessDay, getEasternUtcOffsetHours } from "./businessCalendar.js";

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
