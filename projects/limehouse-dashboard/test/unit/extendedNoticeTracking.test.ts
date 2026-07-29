import { describe, it, expect } from "vitest";
import { newLawFileEligibleDay, findExtendedGraceOccurrences } from "../../src/kpi/extendedNoticeTracking.js";
import type { BuildiumLeaseTransaction } from "../../src/buildium/client.js";

const RENT_INCOME = 3;
const ASOF_JULY_29 = new Date("2026-07-29T00:00:00Z");

function txn(
  overrides: Partial<Omit<BuildiumLeaseTransaction, "Journal">> & { glLines?: Array<[number, string, number]> }
): BuildiumLeaseTransaction {
  const { glLines, ...rest } = overrides;
  return {
    Id: 1,
    LeaseId: 10,
    Date: "2026-07-01",
    TransactionType: "Charge",
    TotalAmount: 0,
    Journal: glLines ? { Memo: null, Lines: glLines.map(([Id, Name, Amount]) => ({ GLAccount: { Id, Name }, Amount })) } : undefined,
    ...rest,
  };
}

describe("newLawFileEligibleDay", () => {
  it("returns the 17th when it falls on a weekday", () => {
    expect(newLawFileEligibleDay("2026-07")).toBe(17); // 2026-07-17 is a Friday
    expect(newLawFileEligibleDay("2026-08")).toBe(17); // 2026-08-17 is a Monday
  });

  it("returns the following Monday (19th) when the 17th falls on a Saturday", () => {
    expect(newLawFileEligibleDay("2026-10")).toBe(19); // 2026-10-17 is a Saturday
  });

  it("returns the following Monday (18th) when the 17th falls on a Sunday", () => {
    expect(newLawFileEligibleDay("2026-05")).toBe(18); // 2026-05-17 is a Sunday
  });
});

describe("findExtendedGraceOccurrences — paid_late", () => {
  it("flags a lease that paid on day 9 (inclusive boundary, confirmed by Jason)", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-07-09", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    const result = findExtendedGraceOccurrences(transactions, null, ASOF_JULY_29);
    expect(result).toEqual([{ month: "2026-07", status: "paid_late", paidDay: 9 }]);
  });

  it("does not flag a lease that paid before day 9 (still within the old law's own safe window)", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-07-08", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    expect(findExtendedGraceOccurrences(transactions, null, ASOF_JULY_29)).toEqual([]);
  });

  it("does not flag a lease that paid after the new law's cutoff (past 07/17, genuinely still late)", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-07-18", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    expect(findExtendedGraceOccurrences(transactions, null, ASOF_JULY_29)).toEqual([]);
  });

  it("flags a lease that paid right on the weekend-adjusted cutoff (10/19, the Monday after 10/17's Saturday)", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-10-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-10-19", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    const asOf = new Date("2026-10-25T00:00:00Z");
    expect(findExtendedGraceOccurrences(transactions, null, asOf)).toEqual([{ month: "2026-10", status: "paid_late", paidDay: 19 }]);
  });

  it("excludes a month before the law's effective month, even if the day math would otherwise flag it", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-06-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-06-12", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    expect(findExtendedGraceOccurrences(transactions, null, ASOF_JULY_29)).toEqual([]);
  });

  // FIXED 2026-07-29, per Jason directly: an NSF bounce reflects real
  // intent to pay on time, so the month is excluded entirely even though
  // the REPLACEMENT payment landed inside the flagged window.
  it("excludes a month with an NSF/reversed payment, even though the eventual real payment landed inside the window", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-07-01", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
      txn({ Id: 3, Date: "2026-07-06", TransactionType: "Reversed Payment", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 4, Date: "2026-07-12", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    expect(findExtendedGraceOccurrences(transactions, null, ASOF_JULY_29)).toEqual([]);
  });

  it("finds multiple occurrences across separate months for a repeat offender, sorted oldest first", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-07-12", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
      txn({ Id: 3, Date: "2026-09-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 4, Date: "2026-09-10", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    const asOf = new Date("2026-09-15T00:00:00Z");
    expect(findExtendedGraceOccurrences(transactions, null, asOf)).toEqual([
      { month: "2026-07", status: "paid_late", paidDay: 12 },
      { month: "2026-09", status: "paid_late", paidDay: 10 },
    ]);
  });

  // FIXED 2026-07-29, real example flagged by Jason directly: 1149 Birks
  // Lane. The tenant's lease didn't start until 7/10/2026 — Buildium's
  // prorated first-month charge naturally resolved right around that same
  // move-in date, which coincidentally landed inside the day-9-17 window
  // and got wrongly flagged as a late payment, even though there was
  // never a normal due date they missed.
  it("excludes the lease's own first billing month, even if its charge resolves inside the window", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-10", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 900]] }),
      txn({ Id: 2, Date: "2026-07-10", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -900]] }),
    ];
    expect(findExtendedGraceOccurrences(transactions, "2026-07-10", ASOF_JULY_29)).toEqual([]);
  });

  it("still flags a later month for the same lease, once past its first billing month", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-10", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 900]] }),
      txn({ Id: 2, Date: "2026-07-10", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -900]] }),
      txn({ Id: 3, Date: "2026-08-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 4, Date: "2026-08-12", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    const asOf = new Date("2026-08-20T00:00:00Z");
    expect(findExtendedGraceOccurrences(transactions, "2026-07-10", asOf)).toEqual([{ month: "2026-08", status: "paid_late", paidDay: 12 }]);
  });

  it("does not exclude anything when leaseFromDate is null (unknown)", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-07-12", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
    ];
    expect(findExtendedGraceOccurrences(transactions, null, ASOF_JULY_29)).toEqual([{ month: "2026-07", status: "paid_late", paidDay: 12 }]);
  });
});

// EXPANDED 2026-07-29, per Jason directly, two real examples: 1311 Tait
// Close (zero payment posted toward July's charge at all) and 2604
// Greenwood Drive (partially paid, well short of the full charge). Both
// were wrongly excluded under the original "must have a fully-resolved
// payment" rule — a tenant who's past the OLD law's day-9 cutoff and
// STILL hasn't paid is exactly who this tracker should surface.
describe("findExtendedGraceOccurrences — still_unpaid", () => {
  it("flags a lease with zero payment at all toward the charge, once past day 9", () => {
    const transactions = [txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1520]] })];
    expect(findExtendedGraceOccurrences(transactions, null, ASOF_JULY_29)).toEqual([{ month: "2026-07", status: "still_unpaid", paidDay: null }]);
  });

  it("flags a lease that only partially paid, well short of the full charge", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 2350]] }),
      txn({ Id: 2, Date: "2026-07-15", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -254.05]] }),
      txn({ Id: 3, Date: "2026-07-20", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -900]] }),
    ];
    expect(findExtendedGraceOccurrences(transactions, null, ASOF_JULY_29)).toEqual([{ month: "2026-07", status: "still_unpaid", paidDay: null }]);
  });

  it("does not flag an unpaid charge before day 9 of the current month — too early to call it either way", () => {
    const transactions = [txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] })];
    const asOf = new Date("2026-07-05T00:00:00Z");
    expect(findExtendedGraceOccurrences(transactions, null, asOf)).toEqual([]);
  });

  it("flags an unpaid charge exactly on day 9 of the current month", () => {
    const transactions = [txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] })];
    const asOf = new Date("2026-07-09T00:00:00Z");
    expect(findExtendedGraceOccurrences(transactions, null, asOf)).toEqual([{ month: "2026-07", status: "still_unpaid", paidDay: null }]);
  });

  it("flags a fully past month that was never paid, regardless of today's day-of-month", () => {
    const transactions = [txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] })];
    const asOf = new Date("2026-08-02T00:00:00Z"); // only day 2 of August, but July is fully over
    expect(findExtendedGraceOccurrences(transactions, null, asOf)).toEqual([{ month: "2026-07", status: "still_unpaid", paidDay: null }]);
  });

  it("has no upper-bound cutoff — stays flagged well past the new law's own 17th-or-Monday cutoff", () => {
    const transactions = [txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] })];
    const asOf = new Date("2026-07-25T00:00:00Z"); // well past the 17th
    expect(findExtendedGraceOccurrences(transactions, null, asOf)).toEqual([{ month: "2026-07", status: "still_unpaid", paidDay: null }]);
  });

  it("skips an already-posted advance charge for a month that hasn't started yet", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-07-12", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
      txn({ Id: 3, Date: "2026-08-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }), // posted early, unpaid, but August hasn't started
    ];
    expect(findExtendedGraceOccurrences(transactions, null, ASOF_JULY_29)).toEqual([{ month: "2026-07", status: "paid_late", paidDay: 12 }]);
  });

  it("treats a payment resolved in a LATER calendar month than the charge as still_unpaid for the charge's own month", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-09-05", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }), // finally paid, but two months late
    ];
    const asOf = new Date("2026-09-10T00:00:00Z");
    expect(findExtendedGraceOccurrences(transactions, null, asOf)).toEqual([{ month: "2026-07", status: "still_unpaid", paidDay: null }]);
  });

  it("excludes an unpaid month if it had an NSF/reversed payment, same as the paid_late case", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
      txn({ Id: 2, Date: "2026-07-01", TransactionType: "Payment", glLines: [[RENT_INCOME, "Rent Income", -1500]] }),
      txn({ Id: 3, Date: "2026-07-06", TransactionType: "Reversed Payment", glLines: [[RENT_INCOME, "Rent Income", 1500]] }),
    ];
    expect(findExtendedGraceOccurrences(transactions, null, ASOF_JULY_29)).toEqual([]);
  });

  it("excludes the lease's own first billing month even when still unpaid", () => {
    const transactions = [txn({ Id: 1, Date: "2026-07-10", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 900]] })];
    expect(findExtendedGraceOccurrences(transactions, "2026-07-10", ASOF_JULY_29)).toEqual([]);
  });

  // FIXED 2026-07-29, real examples flagged by Jason directly: 909 Leisure
  // Square, 127 Repose Lane, 3533 Bernies Court North. All three are new
  // move-ins who prepaid their ENTIRE next month's rent at signing, before
  // that month even started — resolveRentPaymentDates correctly resolves
  // the charge to that earlier date, but the old logic only recognized a
  // same-month resolution, so a fully-prepaid charge fell through to
  // "still_unpaid" even though the real balance was $0 well before the
  // month began.
  it("does not flag a charge that was fully prepaid in an earlier month than the charge itself", () => {
    const transactions = [
      txn({ Id: 1, Date: "2026-06-18", TransactionType: "Applied Prepayment", glLines: [[RENT_INCOME, "Rent Income", -1495]] }),
      txn({ Id: 2, Date: "2026-07-01", TransactionType: "Charge", glLines: [[RENT_INCOME, "Rent Income", 1495]] }),
    ];
    expect(findExtendedGraceOccurrences(transactions, "2026-06-15", ASOF_JULY_29)).toEqual([]);
  });
});
