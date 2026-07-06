import { describe, it, expect } from "vitest";
import { propertyAddressById, withPropertyAddress, unitNumberByLeaseId, withUnitNumber } from "../../src/kpi/propertyLookup.js";
import type { BuildiumProperty } from "../../src/buildium/client.js";

function property(overrides: Partial<BuildiumProperty>): BuildiumProperty {
  return {
    Id: 1,
    Name: "Test Property",
    IsActive: true,
    RentalType: "Rental",
    NumberUnits: 1,
    Address: { AddressLine1: "123 Main St", AddressLine2: null, City: "Norfolk", State: "VA", PostalCode: "23510" },
    RentalManager: null,
    ...overrides,
  };
}

describe("propertyAddressById / withPropertyAddress", () => {
  it("maps property id to its street address, skipping properties with no address on file", () => {
    const map = propertyAddressById([
      property({ Id: 1, Address: { AddressLine1: "123 Main St", AddressLine2: null, City: "Norfolk", State: "VA", PostalCode: "23510" } }),
      property({ Id: 2, Address: { AddressLine1: null, AddressLine2: null, City: null, State: null, PostalCode: null } }),
    ]);
    expect(map.get("1")).toBe("123 Main St");
    expect(map.has("2")).toBe(false);
  });

  it("attaches propertyAddress to each row, null when the property isn't in the map", () => {
    const map = new Map([["1", "123 Main St"]]);
    const rows = withPropertyAddress([{ propertyId: "1", x: 1 }, { propertyId: "2", x: 2 }], map);
    expect(rows[0].propertyAddress).toBe("123 Main St");
    expect(rows[1].propertyAddress).toBeNull();
  });
});

describe("unitNumberByLeaseId / withUnitNumber", () => {
  it("maps lease id to its unit number, skipping leases with no unit number on file", () => {
    const map = unitNumberByLeaseId([
      { Id: 100, UnitNumber: "4B" },
      { Id: 200, UnitNumber: null },
    ]);
    expect(map.get("100")).toBe("4B");
    expect(map.has("200")).toBe(false);
  });

  it("attaches unitNumber to each row, null when the lease isn't in the map", () => {
    const map = new Map([["100", "4B"]]);
    const rows = withUnitNumber([{ leaseId: "100", x: 1 }, { leaseId: "200", x: 2 }], map);
    expect(rows[0].unitNumber).toBe("4B");
    expect(rows[1].unitNumber).toBeNull();
  });
});
