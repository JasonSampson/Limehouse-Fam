import { describe, it, expect } from "vitest";
import { classifyPropertyHealth, summarizePropertyHealth } from "../../src/kpi/propertyHealth.js";
import type { BuildiumProperty, BuildiumUnit, LeaseBalance } from "../../src/buildium/client.js";

function property(overrides: Partial<BuildiumProperty>): BuildiumProperty {
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

function unit(overrides: Partial<BuildiumUnit>): BuildiumUnit {
  return {
    Id: 1,
    PropertyId: 1,
    UnitNumber: "1A",
    UnitSize: 800,
    MarketRent: 1000,
    IsUnitOccupied: true,
    IsUnitListed: false,
    ...overrides,
  };
}

function balance(overrides: Partial<LeaseBalance>): LeaseBalance {
  return {
    leaseId: "1",
    propertyId: "1",
    balance: 0,
    evictionPendingDate: null,
    balancesByGl: [],
    ...overrides,
  };
}

// Priority order confirmed by the coordinator: Off-Market (zero occupied
// units) is checked before At-risk/Commercial, so a fully-vacant
// commercial property still lands as Off-Market, not Commercial.
describe("classifyPropertyHealth", () => {
  it("classifies a fully-vacant property as Off-Market regardless of delinquency or type", () => {
    const properties = [property({ Id: 1 })];
    const units = new Map([["1", [unit({ Id: 1, PropertyId: 1, IsUnitOccupied: false })]]]);
    const result = classifyPropertyHealth(properties, units, []);
    expect(result).toEqual([{ propertyId: "1", category: "Off-Market" }]);
  });

  it("classifies an occupied property with a delinquent lease as At-risk", () => {
    const properties = [property({ Id: 2 })];
    const units = new Map([["2", [unit({ Id: 2, PropertyId: 2, IsUnitOccupied: true })]]]);
    const balances = [balance({ propertyId: "2", balance: 500 })];
    const result = classifyPropertyHealth(properties, units, balances);
    expect(result).toEqual([{ propertyId: "2", category: "At-risk" }]);
  });

  it("classifies an occupied, non-delinquent, non-residential property as Commercial", () => {
    const properties = [property({ Id: 3, RentalType: "Commercial" })];
    const units = new Map([["3", [unit({ Id: 3, PropertyId: 3, IsUnitOccupied: true })]]]);
    const result = classifyPropertyHealth(properties, units, []);
    expect(result).toEqual([{ propertyId: "3", category: "Commercial" }]);
  });

  it("classifies an occupied, non-delinquent, residential property as Healthy", () => {
    const properties = [property({ Id: 4, RentalType: "Residential" })];
    const units = new Map([["4", [unit({ Id: 4, PropertyId: 4, IsUnitOccupied: true })]]]);
    const result = classifyPropertyHealth(properties, units, []);
    expect(result).toEqual([{ propertyId: "4", category: "Healthy" }]);
  });

  it("routes a property with zero unit records to Unknown rather than guessing Off-Market", () => {
    const properties = [property({ Id: 5 })];
    const units = new Map<string, BuildiumUnit[]>(); // no entry for property 5 at all
    const result = classifyPropertyHealth(properties, units, []);
    expect(result).toEqual([{ propertyId: "5", category: "Unknown" }]);
  });

  it("routes an occupied, non-delinquent property with a null RentalType to Unknown", () => {
    const properties = [property({ Id: 6, RentalType: null })];
    const units = new Map([["6", [unit({ Id: 6, PropertyId: 6, IsUnitOccupied: true })]]]);
    const result = classifyPropertyHealth(properties, units, []);
    expect(result).toEqual([{ propertyId: "6", category: "Unknown" }]);
  });

  it("does not use a credit balance (negative) as evidence of delinquency", () => {
    const properties = [property({ Id: 7 })];
    const units = new Map([["7", [unit({ Id: 7, PropertyId: 7, IsUnitOccupied: true })]]]);
    const balances = [balance({ propertyId: "7", balance: -50 })];
    const result = classifyPropertyHealth(properties, units, balances);
    expect(result).toEqual([{ propertyId: "7", category: "Healthy" }]);
  });

  it("counts a property occupied if ANY of its units are occupied, not all", () => {
    const properties = [property({ Id: 8, NumberUnits: 2 })];
    const units = new Map([
      [
        "8",
        [
          unit({ Id: 81, PropertyId: 8, IsUnitOccupied: true }),
          unit({ Id: 82, PropertyId: 8, IsUnitOccupied: false }),
        ],
      ],
    ]);
    const result = classifyPropertyHealth(properties, units, []);
    expect(result).toEqual([{ propertyId: "8", category: "Healthy" }]);
  });
});

describe("summarizePropertyHealth", () => {
  it("tallies counts per category and a total, including zero-count categories", () => {
    const rows = [
      { propertyId: "1", category: "Healthy" as const },
      { propertyId: "2", category: "Healthy" as const },
      { propertyId: "3", category: "At-risk" as const },
      { propertyId: "4", category: "Commercial" as const },
    ];
    const result = summarizePropertyHealth(rows);
    expect(result.totalProperties).toBe(4);
    expect(result.countsByCategory).toEqual({
      Healthy: 2,
      "At-risk": 1,
      Waitlist: 0,
      "On Hold": 0,
      "Off-Market": 0,
      Commercial: 1,
      Unknown: 0,
    });
  });

  it("returns all-zero counts for an empty property list", () => {
    const result = summarizePropertyHealth([]);
    expect(result.totalProperties).toBe(0);
    expect(Object.values(result.countsByCategory).every((c) => c === 0)).toBe(true);
  });
});
