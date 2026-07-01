import { rollForwardToBusinessDay } from "./businessCalendar.js";

// Computes today's intended 10:00 EST run instant for the daily job,
// rolled forward to the next business day if today is a weekend/holiday.
// NOTE: uses a fixed UTC-5 offset (see businessCalendar.ts EST_OFFSET_HOURS
// comment) — does not account for EDT in summer months. Flagged for
// verification: confirm with Jason whether he means literal EST year-round
// or the office's local wall-clock time across the DST transition.
export function computeScheduledRunTime(now: Date, hourEst: number): Date {
  const businessDay = rollForwardToBusinessDay(now);
  const scheduled = new Date(
    Date.UTC(
      businessDay.getUTCFullYear(),
      businessDay.getUTCMonth(),
      businessDay.getUTCDate(),
      hourEst + 5, // EST -> UTC
      0,
      0
    )
  );
  return scheduled;
}
