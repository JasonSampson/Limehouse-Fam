// Office hours: Mon-Fri 9am-5pm, America/New_York (Hampton Roads, VA),
// closed federal holidays. Used by:
//   - the daily job's scheduled run time (10:00 local, next business day if
//     the calendar day is a weekend/holiday)
//   - the PM-reminder / 2-business-day fallback escalation clock
//   - the "alert Jason immediately" failure path, which still needs to know
//     what "immediately" means on a Saturday (next business day, not silent)
//
// Federal holidays are listed by fixed date or computed rule per year.
// This list covers the ones that matter for scheduling; if a new federal
// holiday is added by Congress, update FEDERAL_HOLIDAYS_FIXED below.

// Jason confirmed: the daily job must run at 10am actual Virginia local
// time year-round, not 10am fixed-EST (which silently becomes 9am local
// during EDT, roughly March-November). Resolved via Node's built-in Intl
// API (no new dependency — package.json has no date library) rather than a
// fixed offset: for a given instant, ask what UTC offset America/New_York
// is actually observing right then, DST included.
export function getEasternUtcOffsetHours(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  }).formatToParts(instant);
  const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  // e.g. "GMT-5" or "GMT-4" -> -5 / -4
  const match = /GMT([+-]\d+)/.exec(offsetPart);
  if (!match) {
    throw new Error(`Could not parse America/New_York UTC offset from "${offsetPart}"`);
  }
  return Number(match[1]);
}

// Retained for any external caller still importing the old fixed constant;
// scheduler.ts and this file itself no longer use it for computing run
// times — see getEasternUtcOffsetHours above.
const EST_OFFSET_HOURS = -5;

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const firstWeekday = first.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return new Date(Date.UTC(year, month, day));
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const lastWeekday = last.getUTCDay();
  const offset = (lastWeekday - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, last.getUTCDate() - offset));
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function federalHolidaysForYear(year: number): Set<string> {
  const holidays = new Set<string>();
  holidays.add(dateKey(new Date(Date.UTC(year, 0, 1)))); // New Year's Day
  holidays.add(dateKey(nthWeekdayOfMonth(year, 0, 1, 3))); // MLK Day - 3rd Monday Jan
  holidays.add(dateKey(nthWeekdayOfMonth(year, 1, 1, 3))); // Washington's Birthday - 3rd Monday Feb
  holidays.add(dateKey(lastWeekdayOfMonth(year, 4, 1))); // Memorial Day - last Monday May
  holidays.add(dateKey(new Date(Date.UTC(year, 5, 19)))); // Juneteenth
  holidays.add(dateKey(new Date(Date.UTC(year, 6, 4)))); // Independence Day
  holidays.add(dateKey(nthWeekdayOfMonth(year, 8, 1, 1))); // Labor Day - 1st Monday Sept
  holidays.add(dateKey(nthWeekdayOfMonth(year, 9, 1, 2))); // Columbus Day - 2nd Monday Oct
  holidays.add(dateKey(new Date(Date.UTC(year, 10, 11)))); // Veterans Day
  holidays.add(dateKey(nthWeekdayOfMonth(year, 10, 4, 4))); // Thanksgiving - 4th Thursday Nov
  holidays.add(dateKey(new Date(Date.UTC(year, 11, 25)))); // Christmas
  return holidays;
}

export function isFederalHoliday(date: Date): boolean {
  return federalHolidaysForYear(date.getUTCFullYear()).has(dateKey(date));
}

export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

export function isBusinessDay(date: Date): boolean {
  return !isWeekend(date) && !isFederalHoliday(date);
}

// Advances to the next business day if `date` itself isn't one. Used by the
// scheduler so a notice that "should" fire on a Saturday surfaces the next
// business day, never silently.
export function nextBusinessDay(date: Date): Date {
  const d = new Date(date);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (!isBusinessDay(d));
  return d;
}

export function rollForwardToBusinessDay(date: Date): Date {
  const d = new Date(date);
  while (!isBusinessDay(d)) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

// Adds N business days to a starting instant, skipping weekends/holidays.
// Used for the "unsent by the 2nd business day after the draft was created"
// fallback-decision-maker trigger.
export function addBusinessDays(start: Date, n: number): Date {
  let d = new Date(start);
  let remaining = n;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBusinessDay(d)) remaining -= 1;
  }
  return d;
}

export { EST_OFFSET_HOURS };
