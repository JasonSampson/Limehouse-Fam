import { describe, it, expect } from "vitest";
import {
  findTerminatingCandidates,
  matchCandidatesToActiveProperties,
  isStillExcluded,
  withPendingCloseOutCategory,
} from "../../src/kpi/terminatedProperties.js";
import type { LeadSimpleProcess } from "../../src/leadsimple/client.js";
import type { BuildiumLease, BuildiumProperty } from "../../src/buildium/client.js";

function process(overrides: Partial<LeadSimpleProcess>): LeadSimpleProcess {
  return {
    id: "1",
    name: "07 Lease Renewal Process for Test Address",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-15T00:00:00Z",
    closed_at: null,
    tags: [],
    stage: { id: "s1", name: "Lease Renewed", status: "completed" },
    properties: [{ address: "123 Main St" }],
    ...overrides,
  };
}

function property(overrides: Partial<BuildiumProperty>): BuildiumProperty {
  return {
    Id: 1,
    Name: "123 Main St",
    IsActive: true,
    Address: { AddressLine1: "123 Main St", AddressLine2: null, City: null, State: null, PostalCode: null, Country: null },
    ...overrides,
  } as BuildiumProperty;
}

function lease(overrides: Partial<BuildiumLease>): BuildiumLease {
  return {
    Id: 1,
    PropertyId: 1,
    UnitId: 1,
    LeaseStatus: "Active",
    LeaseFromDate: "2026-01-01",
    LeaseToDate: null,
    CurrentTenants: [{ Id: 1 }],
    ...overrides,
  } as BuildiumLease;
}

describe("findTerminatingCandidates", () => {
  it("flags a property whose latest process is Owner Terminating Management", () => {
    const processes = [process({ stage: { id: "s1", name: "Owner Terminating Management", status: "canceled" } })];
    const result = findTerminatingCandidates(processes);
    expect(result.get("123 Main St")).toEqual({
      address: "123 Main St",
      stage: "Owner Terminating Management",
      terminatedAt: "2026-01-15T00:00:00Z",
    });
  });

  it("flags a property whose latest process is Owner Selling Property", () => {
    const processes = [process({ stage: { id: "s1", name: "Owner Selling Property", status: "canceled" } })];
    const result = findTerminatingCandidates(processes);
    expect(result.has("123 Main St")).toBe(true);
  });

  it("does not flag Owner Relisting -- that means actively re-marketing, not terminated", () => {
    const processes = [process({ stage: { id: "s1", name: "Owner Relisting", status: "canceled" } })];
    const result = findTerminatingCandidates(processes);
    expect(result.has("123 Main St")).toBe(false);
  });

  it("uses only the MOST RECENT process per address, ignoring an older terminal one", () => {
    const processes = [
      process({
        id: "old",
        properties: [{ address: "123 Main St" }],
        stage: { id: "s1", name: "Owner Selling Property", status: "canceled" },
        closed_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      }),
      process({
        id: "new",
        properties: [{ address: "123 Main St" }],
        stage: { id: "s2", name: "Lease Renewed", status: "completed" },
        closed_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }),
    ];
    const result = findTerminatingCandidates(processes);
    expect(result.has("123 Main St")).toBe(false);
  });

  it("keeps a property flagged when the most recent process is still terminal, even with an older non-terminal one", () => {
    const processes = [
      process({
        id: "old",
        properties: [{ address: "123 Main St" }],
        stage: { id: "s1", name: "Lease Renewed", status: "completed" },
        closed_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      }),
      process({
        id: "new",
        properties: [{ address: "123 Main St" }],
        stage: { id: "s2", name: "Owner Terminating Management", status: "canceled" },
        closed_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }),
    ];
    const result = findTerminatingCandidates(processes);
    expect(result.has("123 Main St")).toBe(true);
  });

  it("uses updated_at as the sort key fallback when closed_at is null", () => {
    const processes = [process({ closed_at: null, updated_at: "2026-05-01T00:00:00Z", stage: { id: "s1", name: "Owner Selling Property", status: "canceled" } })];
    const result = findTerminatingCandidates(processes);
    expect(result.get("123 Main St")?.terminatedAt).toBe("2026-05-01T00:00:00Z");
  });

  it("skips a process with no stage", () => {
    const processes = [process({ stage: null })];
    const result = findTerminatingCandidates(processes);
    expect(result.size).toBe(0);
  });

  it("skips a process with no properties", () => {
    const processes = [process({ properties: [] })];
    const result = findTerminatingCandidates(processes);
    expect(result.size).toBe(0);
  });

  it("skips a process whose property has a null address", () => {
    const processes = [process({ properties: [{ address: null }] })];
    const result = findTerminatingCandidates(processes);
    expect(result.size).toBe(0);
  });
});

describe("matchCandidatesToActiveProperties", () => {
  it("matches a candidate address to its active Buildium property", () => {
    const candidates = findTerminatingCandidates([
      process({ stage: { id: "s1", name: "Owner Terminating Management", status: "canceled" } }),
    ]);
    const result = matchCandidatesToActiveProperties(candidates, [property({})]);
    expect(result).toEqual([{ propertyId: "1", address: "123 Main St", stage: "Owner Terminating Management", terminatedAt: "2026-01-15T00:00:00Z" }]);
  });

  it("does not match a property whose address has no candidate", () => {
    const candidates = new Map();
    const result = matchCandidatesToActiveProperties(candidates, [property({})]);
    expect(result).toEqual([]);
  });

  it("skips a property with no address on file", () => {
    const candidates = findTerminatingCandidates([
      process({ stage: { id: "s1", name: "Owner Terminating Management", status: "canceled" } }),
    ]);
    const result = matchCandidatesToActiveProperties(candidates, [
      property({ Address: { AddressLine1: null, AddressLine2: null, City: null, State: null, PostalCode: null, Country: null } as never }),
    ]);
    expect(result).toEqual([]);
  });
});

describe("isStillExcluded", () => {
  it("stays excluded when nothing has happened since the termination decision", () => {
    const result = isStillExcluded("2024-06-01T00:00:00Z", [], null);
    expect(result).toBe(true);
  });

  it("clears the exclusion when a newer lease starts after the termination decision", () => {
    const leases = [lease({ LeaseFromDate: "2026-08-01" })];
    const result = isStillExcluded("2024-06-01T00:00:00Z", leases, null);
    expect(result).toBe(false);
  });

  it("does not clear the exclusion for a lease that started before the termination decision", () => {
    const leases = [lease({ LeaseFromDate: "2023-01-01" })];
    const result = isStillExcluded("2024-06-01T00:00:00Z", leases, null);
    expect(result).toBe(true);
  });

  it("clears the exclusion when an onboarding fee posts after the termination decision", () => {
    const result = isStillExcluded("2024-06-01T00:00:00Z", [], "2026-06-29");
    expect(result).toBe(false);
  });

  it("does not clear the exclusion for an onboarding fee dated before the termination decision", () => {
    const result = isStillExcluded("2024-06-01T00:00:00Z", [], "2023-01-01");
    expect(result).toBe(true);
  });

  it("matches the real 724 Carolina Avenue case: fee first, then a later future lease, both after termination", () => {
    const leases = [lease({ LeaseFromDate: "2026-08-01" })];
    const result = isStillExcluded("2024-01-01T00:00:00Z", leases, "2026-06-29");
    expect(result).toBe(false);
  });
});

describe("withPendingCloseOutCategory", () => {
  it("adds a Pending Close-Out key on top of the existing categories", () => {
    const result = withPendingCloseOutCategory({ Healthy: 17, "At-risk": 5, "Off-Market": 44 }, 8);
    expect(result).toEqual({ Healthy: 17, "At-risk": 5, "Off-Market": 44, "Pending Close-Out": 8 });
  });

  it("does not mutate the input object", () => {
    const input = { Healthy: 1 };
    withPendingCloseOutCategory(input, 3);
    expect(input).toEqual({ Healthy: 1 });
  });

  it("reports a zero count honestly rather than omitting the category", () => {
    const result = withPendingCloseOutCategory({ Healthy: 1 }, 0);
    expect(result["Pending Close-Out"]).toBe(0);
  });
});
