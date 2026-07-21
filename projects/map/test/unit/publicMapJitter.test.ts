import { describe, expect, it } from "vitest";
import { computeJitteredCoordinates } from "../../src/config/publicMapJitter.js";

const TRUE_LAT = 36.8529; // Virginia Beach, roughly
const TRUE_LNG = -75.978;
const RADIUS_METERS = 200;

describe("computeJitteredCoordinates", () => {
  it("is deterministic — same property id always jitters to the same spot", () => {
    const first = computeJitteredCoordinates(42, TRUE_LAT, TRUE_LNG, RADIUS_METERS);
    const second = computeJitteredCoordinates(42, TRUE_LAT, TRUE_LNG, RADIUS_METERS);
    expect(first).toEqual(second);
  });

  it("produces different offsets for different properties", () => {
    const a = computeJitteredCoordinates(1, TRUE_LAT, TRUE_LNG, RADIUS_METERS);
    const b = computeJitteredCoordinates(2, TRUE_LAT, TRUE_LNG, RADIUS_METERS);
    expect(a).not.toEqual(b);
  });

  it("never returns the exact true coordinates (always offset, never zero jitter)", () => {
    const { latitude, longitude } = computeJitteredCoordinates(7, TRUE_LAT, TRUE_LNG, RADIUS_METERS);
    expect(latitude).not.toBe(TRUE_LAT);
    expect(longitude).not.toBe(TRUE_LNG);
  });

  it("stays within the configured radius (meters, via the equirectangular approximation)", () => {
    const METERS_PER_DEGREE_LATITUDE = 111_320;
    for (const propertyId of [1, 2, 3, 100, 999]) {
      const { latitude, longitude } = computeJitteredCoordinates(propertyId, TRUE_LAT, TRUE_LNG, RADIUS_METERS);
      const deltaLatMeters = (latitude - TRUE_LAT) * METERS_PER_DEGREE_LATITUDE;
      const metersPerDegreeLongitude = METERS_PER_DEGREE_LATITUDE * Math.cos((TRUE_LAT * Math.PI) / 180);
      const deltaLngMeters = (longitude - TRUE_LNG) * metersPerDegreeLongitude;
      const distance = Math.sqrt(deltaLatMeters ** 2 + deltaLngMeters ** 2);
      expect(distance).toBeLessThanOrEqual(RADIUS_METERS + 0.01); // small epsilon for float rounding
    }
  });

  it("respects a custom radius", () => {
    const METERS_PER_DEGREE_LATITUDE = 111_320;
    const smallRadius = 5;
    const { latitude, longitude } = computeJitteredCoordinates(55, TRUE_LAT, TRUE_LNG, smallRadius);
    const deltaLatMeters = (latitude - TRUE_LAT) * METERS_PER_DEGREE_LATITUDE;
    expect(Math.abs(deltaLatMeters)).toBeLessThanOrEqual(smallRadius + 0.01);
  });
});
