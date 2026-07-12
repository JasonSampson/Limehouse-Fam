import { describe, it, expect } from "vitest";
import { buildiumOwnerSchema } from "../../src/buildium/client.js";

// Regression coverage for a live bug found 2026-07-03 against Jason's real
// Buildium account (first real credentials for this project):
// GET /api/dashboard/owners failed outright with a schema validation error
// — one real owner record (out of 383) has Email: "" (an empty string,
// which Buildium itself returned, not null) and z.string().email()
// rejects empty strings as invalid RFC email format. Zod validates the
// WHOLE array in one shot, so one bad record failed the entire
// /rentals/owners response, meaning Jason couldn't see ANY owner's data —
// not just the one with the incomplete email. This locks in that the
// schema now accepts any string (including "") or null for Email, since
// format correctness isn't something this ingestion layer should enforce
// on data Buildium itself already accepted and returned.
describe("buildiumOwnerSchema Email field", () => {
  const baseOwner = {
    Id: 1,
    FirstName: "Jane",
    LastName: "Doe",
    IsCompany: false,
    IsActive: true,
    CompanyName: null,
    AlternateEmail: null,
    ManagementAgreementStartDate: null,
    ManagementAgreementEndDate: null,
    PropertyIds: null,
  };

  it("accepts a well-formed email address", () => {
    const result = buildiumOwnerSchema.safeParse({ ...baseOwner, Email: "jane@example.com" });
    expect(result.success).toBe(true);
  });

  it("accepts null (no email on file)", () => {
    const result = buildiumOwnerSchema.safeParse({ ...baseOwner, Email: null });
    expect(result.success).toBe(true);
  });

  it("accepts an empty string — the exact real-world value that broke the old strict schema", () => {
    const result = buildiumOwnerSchema.safeParse({ ...baseOwner, Email: "" });
    expect(result.success).toBe(true);
  });

  it("accepts a loosely-formatted string that would fail strict RFC email validation", () => {
    // Not asserting this IS a valid email — just that this ingestion layer
    // doesn't reject real Buildium data over format strictness the way the
    // old z.string().email() schema did.
    const result = buildiumOwnerSchema.safeParse({ ...baseOwner, Email: "not-an-email-format" });
    expect(result.success).toBe(true);
  });

  it("still rejects a non-string, non-null Email (a genuine shape mismatch, not a format nuance)", () => {
    const result = buildiumOwnerSchema.safeParse({ ...baseOwner, Email: 12345 });
    expect(result.success).toBe(false);
  });

  it("a list of owners with one empty-string email and others well-formed all parse successfully together", () => {
    const owners = [
      { ...baseOwner, Id: 1, Email: "owner1@example.com" },
      { ...baseOwner, Id: 2, Email: "" }, // the real record that broke the old schema
      { ...baseOwner, Id: 3, Email: "owner3@example.com" },
    ];
    const result = owners.map((o) => buildiumOwnerSchema.safeParse(o));
    expect(result.every((r) => r.success)).toBe(true);
  });
});
