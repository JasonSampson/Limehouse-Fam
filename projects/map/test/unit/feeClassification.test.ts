import { describe, expect, it } from "vitest";
import { isExcludedFromDisplay } from "../../src/lib/feeClassification.js";

describe("isExcludedFromDisplay", () => {
  it("excludes the exact confirmed-live label", () => {
    expect(isExcludedFromDisplay("Resident Benefits Package")).toBe(true);
  });

  it("excludes real wording variants seen live (singular, different casing)", () => {
    expect(isExcludedFromDisplay("Resident Benefit Package")).toBe(true);
    expect(isExcludedFromDisplay("resident benefits package")).toBe(true);
    expect(isExcludedFromDisplay("RESIDENT BENEFITS PACKAGE")).toBe(true);
  });

  it("does not exclude real utility/other charge labels", () => {
    expect(isExcludedFromDisplay("Utility Rent - water/sewer/trash")).toBe(false);
    expect(isExcludedFromDisplay("Water, Sewer, Trash")).toBe(false);
    expect(isExcludedFromDisplay("Utility Rent")).toBe(false);
    expect(isExcludedFromDisplay("Solar Rent")).toBe(false);
  });

  it("does not false-positive on unrelated labels containing partial words", () => {
    expect(isExcludedFromDisplay("Resident Parking Fee")).toBe(false);
    expect(isExcludedFromDisplay("Pet Benefit Discount")).toBe(false);
  });

  // Real live gap found by TARS's full-portfolio scan (2026-07-21): lease
  // 2719289 (5064 Heathglen Circle Unit 1) has this exact fee abbreviated to
  // just "RBP" ($45.95/mo, same signature as every spelled-out row), and the
  // phrase-only pattern above didn't catch it — it displayed on the live map
  // until this fix.
  it("excludes the real 'RBP' abbreviation confirmed live (lease 2719289)", () => {
    expect(isExcludedFromDisplay("RBP")).toBe(true);
    expect(isExcludedFromDisplay("rbp")).toBe(true);
    expect(isExcludedFromDisplay("  RBP  ")).toBe(true);
  });

  it("does not false-positive on a label that merely contains 'rbp' as a substring", () => {
    // No real example of this exists in the portfolio (confirmed by the
    // same full scan), but \b keeps the match to a whole word/token so a
    // future unrelated label with "rbp" embedded in a longer word wouldn't
    // be silently swept in.
    expect(isExcludedFromDisplay("Garbpage Fee")).toBe(false);
  });

  // A genuinely ambiguous real label ("Recurring charge", $35, lease
  // unknown) turned up in the same full-portfolio scan that found "RBP" —
  // it doesn't match any known RBP wording or abbreviation, so it correctly
  // stays displayed rather than being guessed into the exclusion list
  // without evidence. Flagged to Jason separately as a real data-quality
  // question, not silently reclassified here.
  it("does not exclude an ambiguous generic label with no evidence it's RBP", () => {
    expect(isExcludedFromDisplay("Recurring charge")).toBe(false);
  });
});
