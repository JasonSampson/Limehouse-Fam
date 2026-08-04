import { describe, it, expect } from "vitest";
import { calculateLateness } from "../../src/lib/lateness.js";

// Pure-function tests for src/lib/lateness.ts. No DB, no network — this is
// the day-4 (standard grace = 3 days) vs day-6 (inherited grace = 5 days)
// clock math Limehouse's SOP depends on: the 14-Day Notice must trigger the
// day AFTER the grace period elapses.
//
// Grace period values (3 / 5) come from migrations 0030/0031 — see
// test/db/gracePeriodConfig.test.ts for the DB-level config that supplies
// them in production; here we test the pure math with those numbers as
// direct inputs, decoupled from the DB.

const DE_MINIMIS = 50;

describe("calculateLateness", () => {
  describe("standard grace period (3 days) — 14-Day Notice triggers day 4", () => {
    it("is NOT late on the due date itself", () => {
      const result = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 3,
        balance: 1500,
        today: new Date("2026-07-01T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.isLate).toBe(false);
      expect(result.daysLate).toBe(0);
      expect(result.qualifiesForNotice).toBe(false);
    });

    it("is NOT late on day 3 (still inside grace)", () => {
      const result = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 3,
        balance: 1500,
        today: new Date("2026-07-03T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.isLate).toBe(false);
      expect(result.qualifiesForNotice).toBe(false);
    });

    it("IS late on day 4 — the day the standard 14-Day Notice clock starts", () => {
      const result = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 3,
        balance: 1500,
        today: new Date("2026-07-04T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.isLate).toBe(true);
      // daysLate counts from the DUE DATE, not from when grace expired —
      // it renders on the notice as "(N days past due)", and on day 4 the
      // rent is plainly 3 days past due. The first live drafting run
      // (2026-08-04) printed "0 days past due" under the old
      // grace-threshold counting, which is wrong on the face of a legal
      // notice.
      expect(result.daysLate).toBe(3);
      expect(result.qualifiesForNotice).toBe(true);
    });

    it("accumulates daysLate correctly past day 4", () => {
      const result = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 3,
        balance: 1500,
        today: new Date("2026-07-14T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.isLate).toBe(true);
      expect(result.daysLate).toBe(13); // July 14 is 13 days past the July 1 due date
    });
  });

  describe("inherited-lease grace period (5 days) — 14-Day Notice triggers day 6", () => {
    it("is NOT late on day 5 (still inside inherited grace)", () => {
      const result = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 5,
        balance: 1500,
        today: new Date("2026-07-05T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.isLate).toBe(false);
    });

    it("IS late on day 6 — the day the inherited-lease 14-Day Notice clock starts", () => {
      const result = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 5,
        balance: 1500,
        today: new Date("2026-07-06T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.isLate).toBe(true);
      expect(result.daysLate).toBe(5); // day 6 = 5 days past the July 1 due date
    });

    it("same due date/today, standard grace is late but inherited grace is not — proves the two are independent", () => {
      const today = new Date("2026-07-04T12:00:00Z"); // day 4 since the 1st
      const standard = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 3,
        balance: 1500,
        today,
        deMinimisThreshold: DE_MINIMIS,
      });
      const inherited = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 5,
        balance: 1500,
        today,
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(standard.isLate).toBe(true);
      expect(inherited.isLate).toBe(false);
    });
  });

  describe("de minimis threshold", () => {
    it("does NOT qualify for notice when balance is below the de minimis threshold", () => {
      const result = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 3,
        balance: 25, // below $50 threshold
        today: new Date("2026-07-10T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.isLate).toBe(true); // still technically late...
      expect(result.qualifiesForNotice).toBe(false); // ...but doesn't warrant a notice
    });

    it("does NOT qualify when balance equals the de minimis threshold exactly (strictly greater-than required)", () => {
      const result = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 3,
        balance: 50,
        today: new Date("2026-07-10T12:00:00Z"),
        deMinimisThreshold: 50,
      });
      expect(result.qualifiesForNotice).toBe(false);
    });

    it("qualifies once balance exceeds the threshold by even a cent", () => {
      const result = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 3,
        balance: 50.01,
        today: new Date("2026-07-10T12:00:00Z"),
        deMinimisThreshold: 50,
      });
      expect(result.qualifiesForNotice).toBe(true);
    });
  });

  describe("zero/negative balance (paid up)", () => {
    it("a zero balance is never late, regardless of how many days have passed", () => {
      const result = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 3,
        balance: 0,
        today: new Date("2026-07-20T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.isLate).toBe(false);
      expect(result.qualifiesForNotice).toBe(false);
    });

    it("a negative balance (credit on the account) is never late", () => {
      const result = calculateLateness({
        rentDueDay: 1,
        gracePeriodDays: 3,
        balance: -75,
        today: new Date("2026-07-20T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.isLate).toBe(false);
    });
  });

  describe("month-end due-day clamping", () => {
    it("clamps a due day of 31 to Feb 28 in a non-leap year", () => {
      const result = calculateLateness({
        rentDueDay: 31,
        gracePeriodDays: 0,
        balance: 1500,
        today: new Date("2026-02-28T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.dueDate.toISOString().slice(0, 10)).toBe("2026-02-28");
      expect(result.isLate).toBe(true);
    });

    it("clamps a due day of 31 to Feb 29 in a leap year (2028)", () => {
      const result = calculateLateness({
        rentDueDay: 31,
        gracePeriodDays: 0,
        balance: 1500,
        today: new Date("2028-02-29T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.dueDate.toISOString().slice(0, 10)).toBe("2028-02-29");
    });

    it("clamps a due day of 31 to April 30 (30-day month)", () => {
      const result = calculateLateness({
        rentDueDay: 31,
        gracePeriodDays: 0,
        balance: 1500,
        today: new Date("2026-04-30T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.dueDate.toISOString().slice(0, 10)).toBe("2026-04-30");
    });
  });

  describe("month rollover — most recent due date before an early-month `today`", () => {
    it("uses last month's due date when today is before this month's due day", () => {
      // rent due the 15th; today is the 3rd -> most recent due date is last month's 15th
      const result = calculateLateness({
        rentDueDay: 15,
        gracePeriodDays: 3,
        balance: 1500,
        today: new Date("2026-07-03T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.dueDate.toISOString().slice(0, 10)).toBe("2026-06-15");
    });

    it("rolls over the year boundary correctly (January due date referencing December)", () => {
      const result = calculateLateness({
        rentDueDay: 15,
        gracePeriodDays: 3,
        balance: 1500,
        today: new Date("2026-01-03T12:00:00Z"),
        deMinimisThreshold: DE_MINIMIS,
      });
      expect(result.dueDate.toISOString().slice(0, 10)).toBe("2025-12-15");
    });
  });
});
