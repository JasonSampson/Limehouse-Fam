import { describe, expect, it } from "vitest";
import { selectPrimaryPhoto } from "../../src/photos/photoSync.js";
import type { BuildiumPropertyImage } from "../../src/buildium/client.js";

// Covers the real bug: photos live at the unit level almost all the time
// (confirmed live, property 167 / unit 1621709 — see schema.md), but
// property-level and unit-level photos aren't mutually exclusive, so this
// precedence logic is what decides which single photo represents a
// property's map pin. Each case below documents which of the three rules
// (unit ShowInListing > property ShowInListing > first available) fired.

function photo(id: number, overrides: Partial<BuildiumPropertyImage> = {}): BuildiumPropertyImage {
  return {
    id,
    fileName: `photo-${id}.jpg`,
    description: null,
    showInListing: false,
    provider: "None",
    ...overrides,
  };
}

describe("selectPrimaryPhoto", () => {
  it("returns null when neither units nor the property have any real photos", () => {
    expect(selectPrimaryPhoto([], [])).toBeNull();
    expect(selectPrimaryPhoto([{ buildiumUnitId: 1, photos: [] }], [])).toBeNull();
  });

  it("prefers a unit's ShowInListing photo over everything else, even if the property also has a ShowInListing photo", () => {
    const unitShown = photo(10, { showInListing: true });
    const propertyShown = photo(20, { showInListing: true });
    const result = selectPrimaryPhoto(
      [{ buildiumUnitId: 501, photos: [photo(9), unitShown] }],
      [propertyShown]
    );
    expect(result).toEqual({ source: "unit", buildiumUnitId: 501, photo: unitShown });
  });

  it("falls back to the property's ShowInListing photo when no unit has one marked", () => {
    const propertyShown = photo(20, { showInListing: true });
    const result = selectPrimaryPhoto(
      [{ buildiumUnitId: 501, photos: [photo(9), photo(10)] }],
      [photo(19), propertyShown]
    );
    expect(result).toEqual({ source: "property", photo: propertyShown });
  });

  it("falls back to the first unit photo (in given unit order) when nothing anywhere is marked ShowInListing", () => {
    const firstUnitPhoto = photo(9);
    const result = selectPrimaryPhoto(
      [
        { buildiumUnitId: 501, photos: [firstUnitPhoto, photo(10)] },
        { buildiumUnitId: 502, photos: [photo(30)] },
      ],
      [photo(19)]
    );
    expect(result).toEqual({ source: "unit", buildiumUnitId: 501, photo: firstUnitPhoto });
  });

  it("falls back to the property's first photo only when no unit has any real photo at all", () => {
    const propertyFirst = photo(19);
    const result = selectPrimaryPhoto(
      [{ buildiumUnitId: 501, photos: [] }],
      [propertyFirst, photo(20)]
    );
    expect(result).toEqual({ source: "property", photo: propertyFirst });
  });

  it("checks units in the given order — a later unit's ShowInListing photo does not win over an earlier unit's if the earlier unit also has one", () => {
    const firstUnitShown = photo(10, { showInListing: true });
    const secondUnitShown = photo(30, { showInListing: true });
    const result = selectPrimaryPhoto(
      [
        { buildiumUnitId: 501, photos: [firstUnitShown] },
        { buildiumUnitId: 502, photos: [secondUnitShown] },
      ],
      []
    );
    expect(result).toEqual({ source: "unit", buildiumUnitId: 501, photo: firstUnitShown });
  });

  it("real scenario: property 167 / unit 1621709 style — property has no photos, unit has several, none marked ShowInListing-first-wins by list order", () => {
    // Mirrors the actual confirmed-live shape for property 167: property-level
    // list is empty, unit-level list has multiple real photos.
    const first = photo(3744361, { showInListing: true });
    const result = selectPrimaryPhoto([{ buildiumUnitId: 1621709, photos: [first, photo(3744375, { showInListing: true })] }], []);
    expect(result).toEqual({ source: "unit", buildiumUnitId: 1621709, photo: first });
  });
});
