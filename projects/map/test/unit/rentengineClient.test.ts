import { describe, expect, it } from "vitest";
import { parseRentEngineUnitsResponse } from "../../src/rentengine/client.js";

// Fixture shapes below are real, confirmed-live records (2026-07-21,
// production regression) — not invented edge cases. A Leased unit at 2642
// East Ocean View Ave (#B4) really does carry a second monthly_fees entry
// whose amount is a string, and that record alone crashed the entire
// rentengine_sync step in production because the old code ran a single
// z.array(schema).parse(json) over the full raw response before filtering
// to on-market listings.
function realLeasedUnitWithStringFeeAmount() {
  return {
    id: 41121,
    status: "Leased",
    target_rental_rate: 1025,
    address: { formatted_address: "2642 East Ocean View Avenue #B4" },
    monthly_fees: [
      { name: "Resident Benefits Package", type: "dollar", amount: 45.95 },
      { name: "water/sewer/trash", type: "dollar", amount: "75" },
    ],
  };
}

function realOnMarketUnit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 74512,
    status: "Available",
    target_rental_rate: 1025,
    address: {
      street_number: "2642",
      street_name: "East Ocean View Avenue",
      unit: "B1",
      city: "Norfolk",
      formatted_address: "2642 East Ocean View Avenue #B1",
    },
    monthly_fees: [{ name: "Resident Benefits Package", type: "dollar", amount: 45.95 }],
    ...overrides,
  };
}

describe("parseRentEngineUnitsResponse", () => {
  it("coerces a real string monthly_fees amount to a number instead of failing", () => {
    // This exact record is Leased (excluded from the final output by
    // isOnMarketStatus), but it must still PARSE without error — the old
    // z.number() schema failed validation on this record even though the
    // record was never going to reach the output.
    const { listings, errors } = parseRentEngineUnitsResponse([realLeasedUnitWithStringFeeAmount()]);
    expect(errors).toEqual([]);
    expect(listings).toEqual([]); // Leased is not on-market, correctly excluded
  });

  it("does not let one malformed record crash parsing of the rest — logs a per-record error instead", () => {
    const badRecord = { id: 99999, status: "Available", target_rental_rate: "not-a-number-and-not-numeric" };
    const goodRecord = realOnMarketUnit();

    const { listings, errors } = parseRentEngineUnitsResponse([badRecord, goodRecord]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("99999");
    expect(errors[0]).toContain("skipped");

    // The good record right next to the bad one must still come through.
    expect(listings).toHaveLength(1);
    expect(listings[0]!.id).toBe(74512);
    expect(listings[0]!.monthlyFees).toEqual([{ label: "Resident Benefits Package", amount: 45.95 }]);
  });

  it("coerces string monthly_fees amounts on a real on-market listing (e.g. a future Rent Engine data fix)", () => {
    const unit = realOnMarketUnit({
      monthly_fees: [
        { name: "Resident Benefits Package", type: "dollar", amount: 45.95 },
        { name: "Water/Sewer/Trash", type: "dollar", amount: "75.00" },
      ],
    });

    const { listings, errors } = parseRentEngineUnitsResponse([unit]);

    expect(errors).toEqual([]);
    expect(listings).toHaveLength(1);
    expect(listings[0]!.monthlyFees).toEqual([
      { label: "Resident Benefits Package", amount: 45.95 },
      { label: "Water/Sewer/Trash", amount: 75 },
    ]);
  });

  it("throws only when the root response isn't even an array (a genuinely different failure class)", () => {
    expect(() => parseRentEngineUnitsResponse({ not: "an array" })).toThrow();
  });
});
