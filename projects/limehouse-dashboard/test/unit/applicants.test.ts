import { describe, it, expect } from "vitest";
import { pendingApplicantRows } from "../../src/kpi/applicants.js";
import type { BuildiumApplicant } from "../../src/buildium/client.js";

function applicant(overrides: Partial<BuildiumApplicant>): BuildiumApplicant {
  return {
    Id: 1,
    PropertyId: 100,
    UnitId: 200,
    FirstName: "Jane",
    LastName: "Doe",
    Status: "Undecided",
    Applications: [{ Id: 1, ApplicationStatus: "Undecided", ApplicationSubmittedDateTime: "2026-06-01T00:00:00Z" }],
    ...overrides,
  };
}

describe("pendingApplicantRows", () => {
  it("shapes an applicant into a row with a joined name", () => {
    const rows = pendingApplicantRows([applicant({})]);
    expect(rows).toEqual([
      {
        applicantId: "1",
        propertyId: "100",
        unitId: "200",
        applicantName: "Jane Doe",
        status: "Undecided",
        submittedDate: "2026-06-01T00:00:00Z",
      },
    ]);
  });

  it("uses null unitId when the applicant has no unit assigned yet", () => {
    const rows = pendingApplicantRows([applicant({ UnitId: null })]);
    expect(rows[0].unitId).toBeNull();
  });

  it("picks the most recent submitted date across multiple applications, not the first in array order", () => {
    const rows = pendingApplicantRows([
      applicant({
        Applications: [
          { Id: 1, ApplicationStatus: "Undecided", ApplicationSubmittedDateTime: "2026-01-01T00:00:00Z" },
          { Id: 2, ApplicationStatus: "Undecided", ApplicationSubmittedDateTime: "2026-06-15T00:00:00Z" },
        ],
      }),
    ]);
    expect(rows[0].submittedDate).toBe("2026-06-15T00:00:00Z");
  });

  it("reports null submittedDate when no application has a date on file", () => {
    const rows = pendingApplicantRows([applicant({ Applications: [{ Id: 1, ApplicationStatus: "New", ApplicationSubmittedDateTime: null }] })]);
    expect(rows[0].submittedDate).toBeNull();
  });

  it("sorts rows by most recently submitted first", () => {
    const rows = pendingApplicantRows([
      applicant({ Id: 1, FirstName: "Older", Applications: [{ Id: 1, ApplicationStatus: "New", ApplicationSubmittedDateTime: "2026-01-01T00:00:00Z" }] }),
      applicant({ Id: 2, FirstName: "Newer", Applications: [{ Id: 2, ApplicationStatus: "New", ApplicationSubmittedDateTime: "2026-06-01T00:00:00Z" }] }),
    ]);
    expect(rows.map((r) => r.applicantName)).toEqual(["Newer Doe", "Older Doe"]);
  });

  it("trims a missing first or last name rather than leaving a stray space", () => {
    const rows = pendingApplicantRows([applicant({ FirstName: null, LastName: "Solo" })]);
    expect(rows[0].applicantName).toBe("Solo");
  });
});
