import type { BuildiumApplicant } from "../buildium/client.js";

// Apps Submitted drill-down — ADDED 2026-07-12. Same population as the
// Apps Submitted tile itself (fetchPendingApplicants — applicants whose
// Status is New or Undecided), just shaped into rows. An applicant can
// have more than one Application record; submittedDate uses the most
// recent ApplicationSubmittedDateTime among them rather than picking the
// first in array order.
export interface ApplicantRow {
  applicantId: string;
  propertyId: string | null;
  unitId: string | null;
  applicantName: string;
  status: string;
  submittedDate: string | null;
}

export function pendingApplicantRows(applicants: BuildiumApplicant[]): ApplicantRow[] {
  return applicants
    .map((a) => {
      const dates = a.Applications.map((app) => app.ApplicationSubmittedDateTime).filter(
        (d): d is string => d !== null
      );
      const submittedDate = dates.length > 0 ? dates.sort().reverse()[0] : null;
      return {
        applicantId: String(a.Id),
        propertyId: a.PropertyId !== null ? String(a.PropertyId) : null,
        unitId: a.UnitId !== null ? String(a.UnitId) : null,
        applicantName: `${a.FirstName ?? ""} ${a.LastName ?? ""}`.trim(),
        status: a.Status,
        submittedDate,
      };
    })
    .sort((a, b) => (b.submittedDate ?? "").localeCompare(a.submittedDate ?? ""));
}
