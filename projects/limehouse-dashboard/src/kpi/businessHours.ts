// Business-hours elapsed time — Monday-Friday, 9:00 AM-5:00 PM America/New_York
// (automatically follows EST/EDT), excluding US federal holidays. Built for
// Resident Response Time (Portfolio Assistant), per Jason directly:
// "Monday-Friday 9am-5pm EST, not including US government holidays."
//
// No date/timezone library exists in this project's dependencies — rather
// than add one for a single KPI, this uses the same technique the rest of
// the project uses for date-only work: native Intl.DateTimeFormat with an
// explicit IANA zone, which already knows the real EST/EDT transition dates
// for any year without a lookup table.

const NY_ZONE = "America/New_York";
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17;

interface NyParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

function nyParts(date: Date): NyParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // hour12: false renders midnight as "24" in some ICU versions — normalize.
  const hour = Number(parts.hour) % 24;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday],
  };
}

// Converts a wall-clock time in America/New_York to the real UTC instant,
// correctly handling whichever offset (EST -05:00 or EDT -04:00) applies on
// that date. Works by taking a UTC guess and correcting for the actual
// zone offset at that instant — safe here since business hours (9am-5pm)
// never straddle the 2am DST transition.
function nyWallClockToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const asNy = nyParts(utcGuess);
  const nyAsUtc = Date.UTC(asNy.year, asNy.month - 1, asNy.day, asNy.hour, asNy.minute);
  const offsetMs = nyAsUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offsetMs);
}

// 4th Thursday of November (Thanksgiving), 3rd Monday (MLK, Washington's
// Birthday), last Monday (Memorial Day), 1st Monday (Labor Day), 2nd Monday
// (Columbus Day) — all already land on the right weekday, no observed-date
// shift needed. Fixed-date holidays (New Year's, Juneteenth, Independence
// Day, Veterans Day, Christmas) shift to the nearest weekday per the real
// federal observance rule: Saturday moves to the preceding Friday, Sunday
// to the following Monday.
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = first.getUTCDay();
  const offset = (weekday - firstWeekday + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay));
  const lastWeekday = last.getUTCDay();
  const offset = (lastWeekday - weekday + 7) % 7;
  return lastDay - offset;
}

function observedDay(year: number, month: number, day: number): { month: number; day: number } {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekday === 6) return day === 1 ? { month: month - 1, day: 31 } : { month, day: day - 1 }; // Saturday -> Friday before
  if (weekday === 0) return { month, day: day + 1 }; // Sunday -> Monday after
  return { month, day };
}

function federalHolidaysForYear(year: number): Set<string> {
  const key = (m: number, d: number) => `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const holidays = new Set<string>();

  const fixedDates: Array<[number, number]> = [
    [1, 1], // New Year's Day
    [6, 19], // Juneteenth
    [7, 4], // Independence Day
    [11, 11], // Veterans Day
    [12, 25], // Christmas
  ];
  for (const [month, day] of fixedDates) {
    const observed = observedDay(year, month, day);
    holidays.add(key(observed.month, observed.day));
  }

  holidays.add(key(1, nthWeekdayOfMonth(year, 1, 1, 3))); // MLK Day: 3rd Monday of January
  holidays.add(key(2, nthWeekdayOfMonth(year, 2, 1, 3))); // Washington's Birthday: 3rd Monday of February
  holidays.add(key(5, lastWeekdayOfMonth(year, 5, 1))); // Memorial Day: last Monday of May
  holidays.add(key(9, nthWeekdayOfMonth(year, 9, 1, 1))); // Labor Day: 1st Monday of September
  holidays.add(key(10, nthWeekdayOfMonth(year, 10, 1, 2))); // Columbus Day: 2nd Monday of October
  holidays.add(key(11, nthWeekdayOfMonth(year, 11, 4, 4))); // Thanksgiving: 4th Thursday of November

  return holidays;
}

const holidayCacheByYear = new Map<number, Set<string>>();
function isFederalHoliday(year: number, month: number, day: number): boolean {
  if (!holidayCacheByYear.has(year)) holidayCacheByYear.set(year, federalHolidaysForYear(year));
  const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return holidayCacheByYear.get(year)!.has(dateKey);
}

// Elapsed business hours between two instants: only Mon-Fri, only
// 9am-5pm America/New_York, excluding US federal holidays. Returns 0 if
// end is before start.
export function businessHoursBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (end <= start) return 0;

  let totalMs = 0;
  const startNy = nyParts(start);
  const endNy = nyParts(end);
  let cursor = Date.UTC(startNy.year, startNy.month - 1, startNy.day);
  const lastDay = Date.UTC(endNy.year, endNy.month - 1, endNy.day);

  while (cursor <= lastDay) {
    const d = new Date(cursor);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const weekday = d.getUTCDay();

    if (weekday !== 0 && weekday !== 6 && !isFederalHoliday(year, month, day)) {
      const windowStart = nyWallClockToUtc(year, month, day, BUSINESS_START_HOUR, 0);
      const windowEnd = nyWallClockToUtc(year, month, day, BUSINESS_END_HOUR, 0);
      const overlapStart = Math.max(windowStart.getTime(), start.getTime());
      const overlapEnd = Math.min(windowEnd.getTime(), end.getTime());
      if (overlapEnd > overlapStart) totalMs += overlapEnd - overlapStart;
    }

    cursor += 24 * 60 * 60 * 1000;
  }

  return totalMs / 36e5;
}
