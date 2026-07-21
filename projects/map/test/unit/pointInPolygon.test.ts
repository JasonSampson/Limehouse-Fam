import { describe, expect, it } from "vitest";
import { isPointInPolygon, validateBoundary } from "../../src/namedAreaExclusions/pointInPolygon.js";

// A simple square roughly over a chunk of Hampton Roads, for readable
// test coordinates rather than real neighborhood boundaries.
const SQUARE = [
  { lat: 36.85, lng: -76.0 },
  { lat: 36.85, lng: -75.9 },
  { lat: 36.95, lng: -75.9 },
  { lat: 36.95, lng: -76.0 },
];

describe("isPointInPolygon", () => {
  it("returns true for a point clearly inside the polygon", () => {
    expect(isPointInPolygon({ lat: 36.9, lng: -75.95 }, SQUARE)).toBe(true);
  });

  it("returns false for a point clearly outside the polygon", () => {
    expect(isPointInPolygon({ lat: 37.5, lng: -75.95 }, SQUARE)).toBe(false);
  });

  it("returns false for a point outside but on the same latitude band", () => {
    expect(isPointInPolygon({ lat: 36.9, lng: -74.0 }, SQUARE)).toBe(false);
  });

  it("throws for a polygon with fewer than 3 points", () => {
    expect(() => isPointInPolygon({ lat: 36.9, lng: -75.95 }, [{ lat: 36.85, lng: -76.0 }])).toThrow(
      /at least 3 points/
    );
  });

  it("handles a non-square (triangle) polygon correctly", () => {
    const triangle = [
      { lat: 36.8, lng: -76.0 },
      { lat: 36.9, lng: -75.9 },
      { lat: 36.8, lng: -75.8 },
    ];
    expect(isPointInPolygon({ lat: 36.83, lng: -75.9 }, triangle)).toBe(true);
    expect(isPointInPolygon({ lat: 36.95, lng: -75.9 }, triangle)).toBe(false);
  });
});

describe("validateBoundary", () => {
  it("accepts a valid boundary and returns it typed", () => {
    const result = validateBoundary(SQUARE);
    expect(result).toEqual(SQUARE);
  });

  it("rejects a non-array value", () => {
    expect(() => validateBoundary({ lat: 1, lng: 2 })).toThrow(/array/);
  });

  it("rejects fewer than 3 points", () => {
    expect(() => validateBoundary([{ lat: 36.85, lng: -76.0 }])).toThrow(/at least 3 points/);
  });

  it("rejects a point missing lat/lng", () => {
    expect(() => validateBoundary([{ lat: 1 }, { lat: 2, lng: 3 }, { lat: 4, lng: 5 }])).toThrow(
      /not a valid \{lat, lng\} pair/
    );
  });

  it("rejects an out-of-range coordinate", () => {
    expect(() =>
      validateBoundary([
        { lat: 200, lng: 5 },
        { lat: 1, lng: 2 },
        { lat: 3, lng: 4 },
      ])
    ).toThrow(/out-of-range/);
  });
});
