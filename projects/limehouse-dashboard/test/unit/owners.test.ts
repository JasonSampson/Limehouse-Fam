import { describe, it, expect } from "vitest";
import { groupOwners } from "../../src/kpi/owners.js";
import type { BuildiumOwner } from "../../src/buildium/client.js";

function owner(overrides: Partial<BuildiumOwner>): BuildiumOwner {
  return {
    Id: 1,
    FirstName: "Jane",
    LastName: "Doe",
    IsCompany: false,
    IsActive: true,
    CompanyName: null,
    Email: null,
    AlternateEmail: null,
    PhoneNumbers: [],
    ManagementAgreementStartDate: null,
    ManagementAgreementEndDate: null,
    PropertyIds: null,
    ...overrides,
  };
}

describe("groupOwners", () => {
  it("keeps two unrelated owners as separate groups", () => {
    const owners = [
      owner({ Id: 1, FirstName: "Jane", LastName: "Doe", PropertyIds: [100] }),
      owner({ Id: 2, FirstName: "John", LastName: "Smith", PropertyIds: [200] }),
    ];
    const groups = groupOwners(owners);
    expect(groups).toHaveLength(2);
  });

  it("merges two owner records that share a property (co-owners)", () => {
    const owners = [
      owner({ Id: 1, FirstName: "Kristine", LastName: "Liang", PropertyIds: [100] }),
      owner({ Id: 2, FirstName: "Michael", LastName: "Liang", PropertyIds: [100] }),
    ];
    const groups = groupOwners(owners);
    expect(groups).toHaveLength(1);
    expect(groups[0].names).toEqual(["Kristine Liang", "Michael Liang"]);
    expect(groups[0].propertyIds).toEqual(["100"]);
  });

  it("merges two owner records that share a phone number but no property (different LLC names)", () => {
    const owners = [
      owner({ Id: 1, CompanyName: "Ramcroft LLC", IsCompany: true, PropertyIds: [100], PhoneNumbers: [{ Number: "(757) 274-4909", Type: "Cell" }] }),
      owner({ Id: 2, FirstName: "Parker", LastName: "Hayslett", PropertyIds: [200], PhoneNumbers: [{ Number: "757-274-4909", Type: "Cell" }] }),
    ];
    const groups = groupOwners(owners);
    expect(groups).toHaveLength(1);
    expect(groups[0].names).toEqual(["Ramcroft LLC", "Parker Hayslett"]);
    expect(groups[0].propertyIds.sort()).toEqual(["100", "200"]);
  });

  it("merges two owner records that share an email but no property or phone", () => {
    const owners = [
      owner({ Id: 1, CompanyName: "1706 Hampton Blvd LLC", IsCompany: true, PropertyIds: [100], Email: "bgomis@gomisgroup.com" }),
      owner({ Id: 2, CompanyName: "2511 Staunton Avenue LLC", IsCompany: true, PropertyIds: [200], AlternateEmail: "bgomis@gomisgroup.com" }),
    ];
    const groups = groupOwners(owners);
    expect(groups).toHaveLength(1);
    expect(groups[0].names).toEqual(["1706 Hampton Blvd LLC", "2511 Staunton Avenue LLC"]);
  });

  it("does not merge owners with no shared property, phone, or email", () => {
    const owners = [
      owner({ Id: 1, PropertyIds: [100], Email: "a@example.com" }),
      owner({ Id: 2, PropertyIds: [200], Email: "b@example.com" }),
    ];
    expect(groupOwners(owners)).toHaveLength(2);
  });

  it("treats a group as active if ANY member is currently active", () => {
    const owners = [
      owner({ Id: 1, PropertyIds: [100], IsActive: false }),
      owner({ Id: 2, PropertyIds: [100], IsActive: true }),
    ];
    const groups = groupOwners(owners);
    expect(groups[0].active).toBe(true);
  });

  it("treats a group as inactive only when every member is inactive", () => {
    const owners = [
      owner({ Id: 1, PropertyIds: [100], IsActive: false }),
      owner({ Id: 2, PropertyIds: [100], IsActive: false }),
    ];
    expect(groupOwners(owners)[0].active).toBe(false);
  });

  it("uses the earliest non-null start date across members", () => {
    const owners = [
      owner({ Id: 1, PropertyIds: [100], ManagementAgreementStartDate: "2023-05-01" }),
      owner({ Id: 2, PropertyIds: [100], ManagementAgreementStartDate: "2021-01-15" }),
    ];
    expect(groupOwners(owners)[0].earliestStart).toBe("2021-01-15");
  });

  it("reports latestEnd as null while the group is still active, even if one member has an old end date", () => {
    const owners = [
      owner({ Id: 1, PropertyIds: [100], IsActive: false, ManagementAgreementEndDate: "2020-01-01" }),
      owner({ Id: 2, PropertyIds: [100], IsActive: true, ManagementAgreementEndDate: null }),
    ];
    expect(groupOwners(owners)[0].latestEnd).toBeNull();
  });

  it("reports the latest end date once the whole group is inactive", () => {
    const owners = [
      owner({ Id: 1, PropertyIds: [100], IsActive: false, ManagementAgreementEndDate: "2020-01-01" }),
      owner({ Id: 2, PropertyIds: [100], IsActive: false, ManagementAgreementEndDate: "2022-06-15" }),
    ];
    expect(groupOwners(owners)[0].latestEnd).toBe("2022-06-15");
  });

  it("ignores empty phone numbers rather than false-matching every owner with no phone", () => {
    const owners = [
      owner({ Id: 1, PropertyIds: [100], PhoneNumbers: [{ Number: "", Type: "Cell" }] }),
      owner({ Id: 2, PropertyIds: [200], PhoneNumbers: [{ Number: "", Type: "Cell" }] }),
    ];
    expect(groupOwners(owners)).toHaveLength(2);
  });

  it("dedupes an identical display name appearing twice within a merged group", () => {
    const owners = [
      owner({ Id: 1, FirstName: "Jane", LastName: "Doe", PropertyIds: [100, 200] }),
      owner({ Id: 2, FirstName: "Jane", LastName: "Doe", PropertyIds: [200] }),
    ];
    const groups = groupOwners(owners);
    expect(groups[0].names).toEqual(["Jane Doe"]);
    expect(groups[0].propertyIds.sort()).toEqual(["100", "200"]);
  });

  it("transitively merges three records linked in a chain (A-B share a property, B-C share a phone)", () => {
    const owners = [
      owner({ Id: 1, FirstName: "A", LastName: "One", PropertyIds: [100] }),
      owner({ Id: 2, FirstName: "B", LastName: "Two", PropertyIds: [100, 200], PhoneNumbers: [{ Number: "5551234567", Type: "Cell" }] }),
      owner({ Id: 3, FirstName: "C", LastName: "Three", PropertyIds: [300], PhoneNumbers: [{ Number: "5551234567", Type: "Cell" }] }),
    ];
    const groups = groupOwners(owners);
    expect(groups).toHaveLength(1);
    expect(groups[0].propertyIds.sort()).toEqual(["100", "200", "300"]);
  });
});
