import { describe, it, expect } from "vitest";
import { formatTenantNameList } from "../../src/templates/renderTemplate.js";

// Decides how tenant names read on the combined notice (one email/PDF to
// every tenant on the lease, per Jason's explicit confirmation that a
// single combined send is fine in place of a separate email per tenant).
describe("formatTenantNameList", () => {
  it("returns a single name unchanged", () => {
    expect(formatTenantNameList(["Jane Doe"])).toBe("Jane Doe");
  });

  it("joins two names with 'and'", () => {
    expect(formatTenantNameList(["Jane Doe", "John Doe"])).toBe("Jane Doe and John Doe");
  });

  it("joins three or more names with an Oxford comma", () => {
    expect(formatTenantNameList(["Jane Doe", "John Doe", "Mary Doe"])).toBe("Jane Doe, John Doe, and Mary Doe");
  });

  it("falls back to 'Tenant' when the list is empty", () => {
    expect(formatTenantNameList([])).toBe("Tenant");
  });
});
