// Per-lease lateness calculation. Pure function, no DB/network access, so
// TARS can test it directly against a table of due-date/grace-period/
// balance/today combinations without needing a live Buildium connection.
export interface LatenessInput {
  rentDueDay: number; // 1-31, day of month rent is due
  gracePeriodDays: number;
  balance: number;
  today: Date; // UTC date, time-of-day ignored
  deMinimisThreshold: number;
}

export interface LatenessResult {
  isLate: boolean;
  dueDate: Date; // the most recent due date on or before today
  // Days since the DUE DATE (not since grace expired) once late; 0 if not
  // yet past grace. This number renders on the legal notice as
  // "(N days past due)", so it must match the plain-English meaning a
  // tenant or judge would read: rent due Aug 1 + 3-day grace, checked
  // Aug 4 → late, and "3 days past due" — not "0 days past due", which
  // the first live drafting run (2026-08-04) produced when this counted
  // from the grace threshold instead. The grace period decides WHEN a
  // tenant becomes late, never how MANY days late they are.
  daysLate: number;
  qualifiesForNotice: boolean; // isLate AND balance > deMinimisThreshold
}

function clampDueDayToMonth(year: number, month: number, day: number): Date {
  // Handles due days like 31 in a 30-day month by clamping to the last
  // actual day of that month, rather than overflowing into the next month.
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfMonth);
  return new Date(Date.UTC(year, month, clampedDay));
}

// Finds the most recent due date that is on or before `today`.
function mostRecentDueDate(rentDueDay: number, today: Date): Date {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const thisMonthDue = clampDueDayToMonth(year, month, rentDueDay);
  if (thisMonthDue.getTime() <= today.getTime()) {
    return thisMonthDue;
  }
  // This month's due date hasn't happened yet — use last month's.
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  return clampDueDayToMonth(prevYear, prevMonth, rentDueDay);
}

export function calculateLateness(input: LatenessInput): LatenessResult {
  const dueDate = mostRecentDueDate(input.rentDueDay, input.today);
  const lateThreshold = new Date(dueDate);
  lateThreshold.setUTCDate(lateThreshold.getUTCDate() + input.gracePeriodDays);

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysPastLateThreshold = Math.floor(
    (input.today.getTime() - lateThreshold.getTime()) / msPerDay
  );
  const daysSinceDueDate = Math.floor((input.today.getTime() - dueDate.getTime()) / msPerDay);

  const isLate = daysPastLateThreshold >= 0 && input.balance > 0;
  const daysLate = isLate ? daysSinceDueDate : 0;
  const qualifiesForNotice = isLate && input.balance > input.deMinimisThreshold;

  return { isLate, dueDate, daysLate, qualifiesForNotice };
}
