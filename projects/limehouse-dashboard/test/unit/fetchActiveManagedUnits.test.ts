import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression coverage for a live bug found 2026-07-05 against Jason's real
// Buildium account: Total Units/Occupancy/Vacant reported 233 units, but
// Jason confirmed live he pays Buildium for and manages 234 doors total —
// the missing one is "6056 Providence Road" (Buildium property id 668408,
// RentalType: "Commercial"), which fetchActiveResidentialUnits()
// intentionally excludes since it filters to RentalType==="Residential"
// only. fetchActiveManagedUnits() is the same active-properties-of-any-
// RentalType set fetchActiveProperties() already returns, resolved down to
// unit records — this test locks in that it includes active Commercial
// properties' units (unlike fetchActiveResidentialUnits) while still
// excluding inactive properties' units.
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  process.env.BUILDIUM_CLIENT_ID = "test_id";
  process.env.BUILDIUM_CLIENT_SECRET = "test_secret";
  process.env.BUILDIUM_BASE_URL = "https://api.buildium.test/v1";
  process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
  process.env.SESSION_COOKIE_SECRET = "test_secret_at_least_16_chars_long";
  process.env.ENTRA_TENANT_ID = "test-tenant";
  process.env.ENTRA_CLIENT_ID = "test-client";
  process.env.ENTRA_CLIENT_SECRET = "test-client-secret";
  process.env.ENTRA_REDIRECT_URI = "https://localhost:3100/auth/callback";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function property(overrides: Partial<Record<string, unknown>>) {
  return {
    Id: 1,
    Name: "Test Property",
    IsActive: true,
    RentalType: "Residential",
    NumberUnits: 1,
    Address: { AddressLine1: "1 Main St", AddressLine2: null, City: "Norfolk", State: "VA", PostalCode: "23500" },
    RentalManager: null,
    ...overrides,
  };
}

function unit(overrides: Partial<Record<string, unknown>>) {
  return {
    Id: 1,
    PropertyId: 1,
    UnitNumber: "A",
    UnitSize: 800,
    MarketRent: 1000,
    IsUnitOccupied: true,
    ...overrides,
  };
}

describe("fetchActiveManagedUnits", () => {
  it("includes units on active Commercial properties (unlike fetchActiveResidentialUnits), but still excludes inactive properties", async () => {
    const properties = [
      property({ Id: 1, IsActive: true, RentalType: "Residential" }), // counts
      property({ Id: 2, IsActive: false, RentalType: "Residential" }), // excluded: inactive
      property({ Id: 3, IsActive: true, RentalType: "Commercial" }), // counts (this is the fix)
      property({ Id: 4, IsActive: false, RentalType: "Commercial" }), // excluded: inactive
    ];
    const units = [
      unit({ Id: 101, PropertyId: 1 }),
      unit({ Id: 102, PropertyId: 2 }),
      unit({ Id: 103, PropertyId: 3 }),
      unit({ Id: 104, PropertyId: 4 }),
    ];

    mockFetch
      .mockResolvedValueOnce(jsonResponse(properties)) // /rentals page 1
      .mockResolvedValueOnce(jsonResponse(units)); // /rentals/units page 1

    const { fetchActiveManagedUnits } = await import("../../src/buildium/client.js");
    const result = await fetchActiveManagedUnits();

    expect(result.map((u) => u.Id).sort()).toEqual([101, 103]);
  });

  it("reproduces the real account's numbers: 234 units (233 residential + 1 commercial), one more than fetchActiveResidentialUnits' 233", async () => {
    const activeResidentialProps = Array.from({ length: 200 }, (_, i) =>
      property({ Id: i + 1, IsActive: true, RentalType: "Residential", NumberUnits: 1 })
    );
    activeResidentialProps[0] = property({ Id: 1, IsActive: true, RentalType: "Residential", NumberUnits: 34 });

    const inactiveProps = Array.from({ length: 122 }, (_, i) =>
      property({ Id: 1000 + i, IsActive: false, RentalType: "Residential" })
    );
    // Real account: "6056 Providence Road", Buildium property id 668408,
    // RentalType: "Commercial", 1 unit — the property this fix picks up.
    const activeCommercialProps = [property({ Id: 668408, IsActive: true, RentalType: "Commercial", NumberUnits: 1 })];

    const activeResidentialUnits = [
      ...Array.from({ length: 34 }, (_, i) => unit({ Id: 10000 + i, PropertyId: 1 })),
      ...activeResidentialProps.slice(1).map((p, i) => unit({ Id: 20000 + i, PropertyId: p.Id as number })),
    ];
    const inactiveUnits = Array.from({ length: 166 }, (_, i) => unit({ Id: 30000 + i, PropertyId: 1000 + (i % 122) }));
    const activeCommercialUnits = [unit({ Id: 40000, PropertyId: 668408 })];

    const allProperties = [...activeResidentialProps, ...inactiveProps, ...activeCommercialProps];
    const allUnits = [...activeResidentialUnits, ...inactiveUnits, ...activeCommercialUnits];

    expect(allUnits.length).toBe(400); // 233 active-residential + 166 inactive + 1 active-commercial

    mockFetch.mockResolvedValueOnce(jsonResponse(allProperties)).mockResolvedValueOnce(jsonResponse(allUnits));

    const { fetchActiveManagedUnits } = await import("../../src/buildium/client.js");
    const result = await fetchActiveManagedUnits();

    expect(result.length).toBe(234); // 233 residential + 1 commercial, matches Jason's confirmed 234 doors paid for
  });

  it("returns an empty array when no properties are active", async () => {
    const properties = [property({ Id: 1, IsActive: false, RentalType: "Residential" })];
    const units = [unit({ Id: 101, PropertyId: 1 })];

    mockFetch.mockResolvedValueOnce(jsonResponse(properties)).mockResolvedValueOnce(jsonResponse(units));

    const { fetchActiveManagedUnits } = await import("../../src/buildium/client.js");
    const result = await fetchActiveManagedUnits();

    expect(result).toEqual([]);
  });
});
