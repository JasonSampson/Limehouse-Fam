import { describe, expect, it } from "vitest";
import {
  normalizeStreetName,
  splitStreetNumber,
  normalizeUnitLabel,
  matchProperty,
  matchUnit,
  type PropertyRow,
  type UnitRow,
} from "../../src/rentengine/addressMatch.js";

describe("normalizeStreetName", () => {
  it("normalizes abbreviated vs spelled-out street types the same way", () => {
    expect(normalizeStreetName("Chesapeake Blvd")).toBe(normalizeStreetName("Chesapeake Boulevard"));
  });

  it("normalizes abbreviated vs spelled-out directionals the same way", () => {
    expect(normalizeStreetName("E Ocean View Ave")).toBe(normalizeStreetName("East Ocean View Avenue"));
  });
});

describe("splitStreetNumber", () => {
  it("splits a real Buildium address_line1 into number + street", () => {
    expect(splitStreetNumber("9117 Chesapeake Boulevard")).toEqual({
      streetNumber: "9117",
      rest: "Chesapeake Boulevard",
    });
  });
});

describe("normalizeUnitLabel", () => {
  it("treats '#B4', 'Unit B4', and 'B4' as the same unit", () => {
    const normalized = normalizeUnitLabel("B4");
    expect(normalizeUnitLabel("#B4")).toBe(normalized);
    expect(normalizeUnitLabel("Unit B4")).toBe(normalized);
  });
});

// Real addresses confirmed live 2026-07-21 from Jason's RentEngine account
// and the matching real map.properties/map.units rows.
const properties: PropertyRow[] = [
  { id: 120, address_line1: "9117 Chesapeake Boulevard", address_line2: null, city: "Norfolk" },
  { id: 98, address_line1: "2642 East Ocean View Avenue", address_line2: null, city: "Norfolk" },
  { id: 3, address_line1: "420 West 30th Street", address_line2: null, city: "Norfolk" },
];

const unitsByProperty: Record<number, UnitRow[]> = {
  120: [
    { id: 1, unit_label: "1" },
    { id: 2, unit_label: "4" },
    { id: 3, unit_label: "5" },
  ],
  98: [
    { id: 10, unit_label: "A1" },
    { id: 11, unit_label: "B4" },
  ],
  3: [{ id: 20, unit_label: "1" }],
};

describe("matchProperty (real confirmed examples)", () => {
  it('matches RentEngine "9117 Chesapeake Blvd #5" to Buildium\'s "9117 Chesapeake Boulevard"', () => {
    const result = matchProperty(
      { streetNumber: "9117", streetName: "Chesapeake Blvd", unit: "5", city: "Norfolk", formattedAddress: "9117 Chesapeake Blvd #5" },
      properties
    );
    expect(result.status).toBe("matched");
    expect(result.property?.id).toBe(120);
  });

  it('matches RentEngine "2642 E Ocean View Ave #B4" to Buildium\'s "2642 East Ocean View Avenue"', () => {
    const result = matchProperty(
      { streetNumber: "2642", streetName: "E Ocean View Ave", unit: "B4", city: "Norfolk", formattedAddress: "2642 E Ocean View Ave #B4" },
      properties
    );
    expect(result.status).toBe("matched");
    expect(result.property?.id).toBe(98);
  });

  it("falls back to parsing formattedAddress when structured fields are missing", () => {
    const result = matchProperty(
      { streetNumber: null, streetName: null, unit: null, city: null, formattedAddress: "420 West 30th Street" },
      properties
    );
    expect(result.status).toBe("matched");
    expect(result.property?.id).toBe(3);
  });

  it("returns no_candidates for an address with no real Buildium match (deliberate mismatch)", () => {
    const result = matchProperty(
      { streetNumber: "9999", streetName: "Nonexistent Lane", unit: null, city: "Norfolk", formattedAddress: "9999 Nonexistent Ln" },
      properties
    );
    expect(result.status).toBe("no_candidates");
    expect(result.property).toBeNull();
  });
});

describe("matchUnit (real confirmed examples)", () => {
  it("resolves a single-unit property without needing a RentEngine unit label", () => {
    const result = matchUnit(null, unitsByProperty[3]);
    expect(result.status).toBe("not_needed");
    expect(result.unit?.id).toBe(20);
  });

  it("matches the right unit on a multi-unit property by normalized label", () => {
    const result = matchUnit("5", unitsByProperty[120]);
    expect(result.status).toBe("matched");
    expect(result.unit?.id).toBe(3);
  });

  it("refuses to guess when a multi-unit property gets no usable RentEngine unit label", () => {
    const result = matchUnit(null, unitsByProperty[120]);
    expect(result.status).toBe("ambiguous");
    expect(result.unit).toBeNull();
  });

  it("refuses to guess when the RentEngine unit label doesn't match any real unit", () => {
    const result = matchUnit("Z9", unitsByProperty[120]);
    expect(result.status).toBe("no_candidates");
    expect(result.unit).toBeNull();
  });
});
