import type { BuildiumLeaseTransaction } from "../buildium/client.js";
import { resolveRentPaymentDates } from "./rentCollection.js";

// "Extended Grace" tile (Financials section) — ADDED 2026-07-29, per Jason
// directly. Virginia's landlord-tenant pay-or-quit notice period changed
// 2026-07-01: a 5-day notice became a 14-day one. Rent is due the 1st,
// late after the 3rd (late as of the 4th). Per Jason's own confirmed
// counting: the 4th counts as day 1 of the notice period. Under the OLD
// 5-day notice, the 9th was the first day an eviction could actually be
// filed. Under the NEW 14-day notice, that same counting reaches the
// 17th — except the office doesn't work weekends, so if the 17th lands on
// a Saturday or Sunday the real first-fileable day slides to the
// following Monday (the tenant gets those extra days by default, per
// Jason). This tile tracks tenants paying specifically INSIDE the gap the
// law change created: on/after the OLD law's day-9 cutoff, but still
// on/before THIS month's real NEW law cutoff — the population who would
// already have been eviction-filing-eligible under the old law but isn't
// yet under the new one.
export const EXTENDED_NOTICE_LAW_EFFECTIVE_MONTH = "2026-07"; // "extra days" isn't a real concept before the law existed
const OLD_LAW_FILE_ELIGIBLE_DAY = 9; // confirmed by Jason directly, 2026-07-29

// The 17th, pushed to the following Monday if it falls on a Saturday or
// Sunday.
export function newLawFileEligibleDay(month: string): number {
  const [year, mon] = month.split("-").map(Number);
  const seventeenth = new Date(Date.UTC(year, mon - 1, 17));
  const dayOfWeek = seventeenth.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (dayOfWeek === 6) return 19; // Saturday -> the following Monday
  if (dayOfWeek === 0) return 18; // Sunday -> the following Monday
  return 17;
}

export interface ExtendedGraceOccurrence {
  month: string; // "YYYY-MM"
  status: "paid_late" | "still_unpaid";
  paidDay: number | null; // day of month the charge was fully paid off — null when status is "still_unpaid"
}

function currentMonthStr(asOfDate: Date): string {
  return `${asOfDate.getUTCFullYear()}-${String(asOfDate.getUTCMonth() + 1).padStart(2, "0")}`;
}

// One lease's full history of months where rent, as of that month's own
// timeline, sat specifically inside the "extra grace" gap. A month is
// skipped entirely if it had an NSF/reversed payment (TransactionType
// "Reversed Payment") — per Jason directly, a bounced payment reflects
// real intent to pay on time, not a tenant waiting out the longer notice
// period, so it shouldn't count against them even though the money didn't
// actually land until later.
//
// FIXED 2026-07-29, real example: 1149 Birks Lane — the tenant's lease
// didn't start until 7/10/2026, and Buildium's own first-month charge for
// a mid-month move-in is a prorated amount that naturally posts/resolves
// right around the move-in date itself, not a normal recurring charge due
// the 1st. That coincidentally landed inside the day-9-to-17 window and
// got flagged as "late," even though there was never a normal due date
// they missed. `leaseFromDate` (Buildium's LeaseFromDate, "YYYY-MM-DD" or
// null) excludes the lease's own first billing month entirely, regardless
// of which day it starts on — that month's charge timing isn't a reliable
// "did they pay late" signal either way.
//
// EXPANDED 2026-07-29, same day, two more real examples: 1311 Tait Close
// (zero payment posted toward July's charge at all) and 2604 Greenwood
// Drive (partially paid, well short of the full charge). Both were
// excluded under the original "must have a fully-resolved payment date"
// rule — per Jason directly, that was wrong: a tenant who's past the OLD
// law's day-9 cutoff and STILL hasn't paid is exactly who this tracker
// should surface, arguably more than someone who already resolved it.
// status "still_unpaid" covers both a charge with no resolution at all as
// of `asOfDate`, AND a charge that only resolved in a LATER calendar
// month than the charge itself (rolled-over back rent) — as of ITS OWN
// month's timeline, that charge was genuinely still unpaid past the
// cutoff, even though the ledger eventually catches up. Unlike
// "paid_late", "still_unpaid" has no upper-bound cutoff — there's no
// resolution date to cap, and both real examples were already well past
// the new law's own 17th-or-Monday cutoff too. Only flagged once
// `asOfDate` has actually reached day 9 of that month (a still-unpaid
// charge on, say, day 5 of the current month is just normal early
// lateness, not yet a real "extended grace" case either way); a charge
// for a month that hasn't started yet (an already-posted advance charge)
// is skipped entirely.
export function findExtendedGraceOccurrences(
  transactions: BuildiumLeaseTransaction[],
  leaseFromDate: string | null,
  asOfDate: Date
): ExtendedGraceOccurrence[] {
  const paymentDateByMonth = resolveRentPaymentDates(transactions);
  const nsfMonths = new Set(
    transactions.filter((t) => t.TransactionType === "Reversed Payment").map((t) => t.Date.slice(0, 7))
  );
  const firstBillingMonth = leaseFromDate ? leaseFromDate.slice(0, 7) : null;
  const thisMonth = currentMonthStr(asOfDate);

  const occurrences: ExtendedGraceOccurrence[] = [];
  for (const [month, paidDate] of paymentDateByMonth.entries()) {
    if (month < EXTENDED_NOTICE_LAW_EFFECTIVE_MONTH) continue;
    if (firstBillingMonth !== null && month <= firstBillingMonth) continue;
    if (nsfMonths.has(month)) continue;
    if (month > thisMonth) continue; // an already-posted advance charge for a month that hasn't started yet

    const paidInSameMonth = paidDate !== null && paidDate.slice(0, 7) === month;

    if (paidInSameMonth) {
      const paidDay = Number((paidDate as string).slice(8, 10));
      const cutoff = newLawFileEligibleDay(month);
      if (paidDay >= OLD_LAW_FILE_ELIGIBLE_DAY && paidDay <= cutoff) {
        occurrences.push({ month, status: "paid_late", paidDay });
      }
      continue;
    }

    // Either never resolved at all, or only resolved in a LATER calendar
    // month than the charge (rolled-over back rent) — either way, as of
    // this month's own timeline, still unpaid.
    const effectiveAsOfDay = month === thisMonth ? asOfDate.getUTCDate() : 32; // a past month has fully run its course
    if (effectiveAsOfDay >= OLD_LAW_FILE_ELIGIBLE_DAY) {
      occurrences.push({ month, status: "still_unpaid", paidDay: null });
    }
  }
  return occurrences.sort((a, b) => a.month.localeCompare(b.month));
}
