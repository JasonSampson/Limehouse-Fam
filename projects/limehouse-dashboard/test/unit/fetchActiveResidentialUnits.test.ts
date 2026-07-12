import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression coverage for a live bug found 2026-07-03 against Jason's real
// Buildium account: /api/dashboard/occupancy reported 401 total units, but
// Jason confirmed his real managed portfolio is ~230 (matching CLAUDE.md).
// Investigated against the real account's actual data (not generic docs):
// properties carry IsActive (true/false) and RentalType
// ("Residential"/"Commercial"). Filtering to IsActive===true AND
// RentalType==="Residential" and cross-checking two different ways (sum of
// property.NumberUnits vs. counting actual unit records) both
// independently landed on 233 — in the ~230 range Jason confirmed. This
// test locks in that fetchActiveResidentialUnits() applies exactly that
// filter, using a small fixture shaped like the real account's mix
// (active+residential, inactive, and commercial properties together).
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
    IsUnitListed: false,
    ...overrides,
  };
}

describe("fetchActiveResidentialUnits", () => {
  it("excludes units belonging to inactive properties and commercial properties", async () => {
    const properties = [
      property({ Id: 1, IsActive: true, RentalType: "Residential" }), // counts
      property({ Id: 2, IsActive: false, RentalType: "Residential" }), // excluded: inactive
      property({ Id: 3, IsActive: true, RentalType: "Commercial" }), // excluded: not residential
      property({ Id: 4, IsActive: true, RentalType: "Residential" }), // counts
    ];
    const units = [
      unit({ Id: 101, PropertyId: 1 }),
      unit({ Id: 102, PropertyId: 2 }),
      unit({ Id: 103, PropertyId: 3 }),
      unit({ Id: 104, PropertyId: 4 }),
      unit({ Id: 105, PropertyId: 4 }),
    ];

    // fetchProperties() calls /rentals (paginated); fetchAllUnits() calls
    // /rentals/units (paginated). Mock returns full results on page 1, then
    // an empty page 2 to satisfy buildiumGetAllPages' "fewer than pageSize
    // means last page" pagination check.
    mockFetch
      .mockResolvedValueOnce(jsonResponse(properties)) // /rentals page 1
      .mockResolvedValueOnce(jsonResponse(units)); // /rentals/units page 1

    const { fetchActiveResidentialUnits } = await import("../../src/buildium/client.js");
    const result = await fetchActiveResidentialUnits();

    expect(result.map((u) => u.Id).sort()).toEqual([101, 104, 105]);
  });

  it("returns an empty array when no properties are active+residential", async () => {
    const properties = [property({ Id: 1, IsActive: false, RentalType: "Residential" })];
    const units = [unit({ Id: 101, PropertyId: 1 })];

    mockFetch.mockResolvedValueOnce(jsonResponse(properties)).mockResolvedValueOnce(jsonResponse(units));

    const { fetchActiveResidentialUnits } = await import("../../src/buildium/client.js");
    const result = await fetchActiveResidentialUnits();

    expect(result).toEqual([]);
  });

  it("reproduces the real account's numbers at the correct order of magnitude (233 units from 401 raw)", async () => {
    // Simplified version of the real account's mix: enough active+residential
    // properties to land near 230, plus a chunk of inactive/commercial noise
    // matching the real 401 vs 233 gap discovered live.
    const activeResidentialProps = Array.from({ length: 200 }, (_, i) =>
      property({ Id: i + 1, IsActive: true, RentalType: "Residential", NumberUnits: 1 })
    );
    // A few multi-unit properties to reach 233 active+residential units from 200 properties.
    activeResidentialProps[0] = property({ Id: 1, IsActive: true, RentalType: "Residential", NumberUnits: 34 });

    const inactiveProps = Array.from({ length: 122 }, (_, i) =>
      property({ Id: 1000 + i, IsActive: false, RentalType: "Residential" })
    );
    const commercialProps = [
      property({ Id: 2000, IsActive: true, RentalType: "Commercial" }),
      property({ Id: 2001, IsActive: true, RentalType: "Commercial" }),
    ];

    const activeResidentialUnits = [
      ...Array.from({ length: 34 }, (_, i) => unit({ Id: 10000 + i, PropertyId: 1 })),
      ...activeResidentialProps.slice(1).map((p, i) => unit({ Id: 20000 + i, PropertyId: p.Id as number })),
    ];
    // 233 active-residential + 166 inactive + 2 commercial = 401, matching
    // the real total unit count reported live before this fix.
    const inactiveUnits = Array.from({ length: 166 }, (_, i) => unit({ Id: 30000 + i, PropertyId: 1000 + (i % 122) }));
    const commercialUnits = [unit({ Id: 40000, PropertyId: 2000 }), unit({ Id: 40001, PropertyId: 2001 })];

    const allProperties = [...activeResidentialProps, ...inactiveProps, ...commercialProps];
    const allUnits = [...activeResidentialUnits, ...inactiveUnits, ...commercialUnits];

    expect(allUnits.length).toBe(401); // matches the real reported over-count exactly

    mockFetch.mockResolvedValueOnce(jsonResponse(allProperties)).mockResolvedValueOnce(jsonResponse(allUnits));

    const { fetchActiveResidentialUnits } = await import("../../src/buildium/client.js");
    const result = await fetchActiveResidentialUnits();

    expect(result.length).toBe(233); // matches the real corrected count exactly
    expect(result.length).toBeGreaterThan(220);
    expect(result.length).toBeLessThan(240); // in the ~230 range Jason confirmed
  });
});
