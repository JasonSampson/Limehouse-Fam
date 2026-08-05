import { describe, it, expect } from "vitest";
import {
  getTimeOfDayGreeting,
  formatOrdinalDate,
  formatDueMonthName,
  computePaymentDeadline,
  formatTenantFirstNames,
  renderCoverEmailHtml,
} from "../../src/lib/coverEmailFormatting.js";

// All instants below are chosen in August (EDT, UTC-4) to match this
// feature's real rollout date and avoid DST-boundary ambiguity in the
// test data itself — getEasternLocalHourMinute (scheduler.ts) is already
// separately proven DST-aware.
describe("getTimeOfDayGreeting", () => {
  it("says Good morning right up to 11:59am Eastern", () => {
    // 11:59am EDT = 15:59 UTC
    expect(getTimeOfDayGreeting(new Date("2026-08-04T15:59:00Z"))).toBe("Good morning");
  });

  it("switches to Good afternoon exactly at noon Eastern", () => {
    // 12:00pm EDT = 16:00 UTC
    expect(getTimeOfDayGreeting(new Date("2026-08-04T16:00:00Z"))).toBe("Good afternoon");
  });

  it("stays Good afternoon right up to 4:59pm Eastern", () => {
    // 4:59pm EDT = 20:59 UTC
    expect(getTimeOfDayGreeting(new Date("2026-08-04T20:59:00Z"))).toBe("Good afternoon");
  });

  it("switches to Good evening exactly at 5pm Eastern (matches office-hours close)", () => {
    // 5:00pm EDT = 21:00 UTC
    expect(getTimeOfDayGreeting(new Date("2026-08-04T21:00:00Z"))).toBe("Good evening");
  });

  it("stays Good evening late at night", () => {
    // 11:30pm EDT = 03:30 UTC the next day
    expect(getTimeOfDayGreeting(new Date("2026-08-05T03:30:00Z"))).toBe("Good evening");
  });
});

describe("formatOrdinalDate", () => {
  it.each([
    ["2026-08-01T00:00:00Z", "August 1st"],
    ["2026-08-02T00:00:00Z", "August 2nd"],
    ["2026-08-03T00:00:00Z", "August 3rd"],
    ["2026-08-04T00:00:00Z", "August 4th"],
    ["2026-08-11T00:00:00Z", "August 11th"], // the 11-13 exception, not "11st"
    ["2026-08-12T00:00:00Z", "August 12th"],
    ["2026-08-13T00:00:00Z", "August 13th"],
    ["2026-08-21T00:00:00Z", "August 21st"],
    ["2026-08-22T00:00:00Z", "August 22nd"],
    ["2026-08-23T00:00:00Z", "August 23rd"],
    ["2026-08-31T00:00:00Z", "August 31st"],
  ])("formats %s as %s", (iso, expected) => {
    expect(formatOrdinalDate(new Date(iso))).toBe(expected);
  });
});

describe("formatDueMonthName", () => {
  it("returns just the month name", () => {
    expect(formatDueMonthName(new Date("2026-08-01T00:00:00Z"))).toBe("August");
  });
});

describe("computePaymentDeadline", () => {
  // Corrected 2026-08-05 after Jason checked: Va. Code § 1-210 excludes
  // the day of the triggering event when counting forward, so a notice
  // served Aug 4 doesn't count Aug 4 itself — Aug 5 is day 1, Aug 18 is
  // day 14. The company's prior standard email had this one day early
  // (Aug 17) for an unknown length of time before this correction.
  it("is 14 days AFTER the day the notice is sent, per Va. Code § 1-210 (sent Aug 4, deadline Aug 18 — not Aug 17)", () => {
    const deadline = computePaymentDeadline(new Date("2026-08-04T18:30:00Z"));
    expect(formatOrdinalDate(deadline)).toBe("August 18th");
  });

  it("crosses a month boundary correctly", () => {
    const deadline = computePaymentDeadline(new Date("2026-08-25T00:00:00Z"));
    expect(formatOrdinalDate(deadline)).toBe("September 8th");
  });
});

describe("formatTenantFirstNames", () => {
  it("returns the single first name unchanged", () => {
    expect(formatTenantFirstNames(["Keith Braddy"])).toBe("Keith");
  });

  it('joins two tenants\' first names with "and" — Jason\'s exact example', () => {
    expect(formatTenantFirstNames(["Corinne Mosley", "Ladereck Mosley"])).toBe("Corinne and Ladereck");
  });

  it("joins three or more with an Oxford comma", () => {
    expect(formatTenantFirstNames(["Jane Doe", "John Doe", "Mary Smith"])).toBe("Jane, John, and Mary");
  });

  it("falls back to the whole string for a single-word name", () => {
    expect(formatTenantFirstNames(["Cher"])).toBe("Cher");
  });
});

describe("renderCoverEmailHtml", () => {
  const fields = {
    greeting: "Good afternoon",
    tenant_first_names: "Corinne and Ladereck",
    due_month_name: "August",
    payment_deadline: "August 18th",
  };

  it("renders the greeting, payment paragraph, address intro, static address block, and closing as five separate <p> elements", () => {
    const html = renderCoverEmailHtml(fields);
    const paragraphs = html.split("\n").filter((line) => line.startsWith("<p>"));
    expect(paragraphs).toHaveLength(5);
    expect(paragraphs[0]).toBe("<p>Good afternoon Corinne and Ladereck,</p>");
    expect(paragraphs[1]).toContain("past due rent for August");
    expect(paragraphs[1]).toContain("August 18th");
    expect(paragraphs[2]).toBe("<p>For payments to our office, our office address is below:</p>");
  });

  it("renders the static office address as one paragraph with real line breaks, not run together", () => {
    const html = renderCoverEmailHtml(fields);
    expect(html).toContain("<p>Limehouse Property Management<br>6056 Providence Road, Suite 200<br>Virginia Beach, VA 23464</p>");
  });

  it("includes the drop-slot closing paragraph", () => {
    const html = renderCoverEmailHtml(fields);
    expect(html).toContain("drop slot");
    expect(html).toContain("Please advise status of payment");
  });

  it("HTML-escapes merge field values exactly once", () => {
    const html = renderCoverEmailHtml({ ...fields, tenant_first_names: `O'Brien & Sons` });
    expect(html).toContain("O&#39;Brien &amp; Sons");
    expect(html).not.toContain("&amp;#39;");
  });

  it("never repeats the full legal notice text — Jason's whole point in requesting this change", () => {
    const html = renderCoverEmailHtml(fields);
    expect(html).not.toContain("ITEMIZED CHARGES");
    expect(html).not.toContain("55.1-1245");
    expect(html).not.toContain("YOU MAY AVOID PAYING");
  });
});
