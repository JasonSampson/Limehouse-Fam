import { describe, it, expect } from "vitest";
import { buildVacancyCycles, countApplicationsInCycles, groupVacancyRowsByUnit } from "../../src/kpi/vacancyApplications.js";
import type { BuildiumLease, BuildiumApplicant } from "../../src/buildium/client.js";

function lease(overrides: Partial<BuildiumLease>): BuildiumLease {
  return {
    Id: 1,
    PropertyId: 100,
    UnitId: 10,
    UnitNumber: "1",
    LeaseStatus: "Past",
    LeaseType: "Fixed",
    LeaseFromDate: "2024-01-01",
    LeaseToDate: "2024-12-31",
    IsEvictionPending: false,
    PaymentDueDay: 1,
    CurrentTenants: null,
    MoveOutData: [],
    Tenants: [],
    ...overrides,
  };
}

function applicant(overrides: Partial<BuildiumApplicant>): BuildiumApplicant {
  return {
    Id: 1,
    PropertyId: 100,
    UnitId: 10,
    FirstName: "Jane",
    LastName: "Doe",
    Status: "Undecided",
    Applications: [{ Id: 1, ApplicationStatus: "Undecided", ApplicationSubmittedDateTime: "2025-01-15T00:00:00Z" }],
    ...overrides,
  };
}

const unit = { Id: 10, PropertyId: 100 };
const asOf = new Date("2026-07-12T00:00:00Z");

describe("buildVacancyCycles", () => {
  it("builds a closed vacancy cycle from the gap between two leases on the same unit", () => {
    const leases = [
      lease({ Id: 1, LeaseFromDate: "2023-01-01", LeaseToDate: "2024-12-31" }),
      lease({ Id: 2, LeaseFromDate: "2025-02-01", LeaseToDate: "2060-01-01" }),
    ];
    const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
    expect(cycles).toEqual([{ propertyId: "100", unitId: "10", start: "2024-12-31", end: "2025-02-01" }]);
  });

  it("builds an ongoing (open-ended) cycle when there's no next lease", () => {
    const leases = [lease({ Id: 1, LeaseFromDate: "2023-01-01", LeaseToDate: "2025-06-01" })];
    const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
    expect(cycles).toEqual([{ propertyId: "100", unitId: "10", start: "2025-06-01", end: null }]);
  });

  it("refines an ongoing cycle's start using a real Buildium ListingDate, when it's earlier than the lease end (pre-leasing before move-out)", () => {
    const leases = [lease({ Id: 1, LeaseFromDate: "2023-01-01", LeaseToDate: "2025-06-01" })];
    const listingDateByUnitId = new Map([["10", "2025-05-20"]]);
    const cycles = buildVacancyCycles([unit], leases, listingDateByUnitId, new Map(), asOf, 5);
    expect(cycles[0].start).toBe("2025-05-20");
  });

  it("ignores a ListingDate that's LATER than the lease end (a real make-ready gap before the unit got listed)", () => {
    const leases = [lease({ Id: 1, LeaseFromDate: "2023-01-01", LeaseToDate: "2025-06-01" })];
    const listingDateByUnitId = new Map([["10", "2025-06-20"]]);
    const cycles = buildVacancyCycles([unit], leases, listingDateByUnitId, new Map(), asOf, 5);
    expect(cycles[0].start).toBe("2025-06-01");
  });

  // CONFIRMED LIVE 2026-07-12: the real bug Jason caught -- 1149 Birks
  // Lane had 7 real applicants apply 4+ weeks before the lease's own end
  // date, none of which the original version of this logic counted,
  // because it only ever started counting from LeaseToDate itself.
  it("refines a closed cycle's start using the outgoing lease's real NoticeGivenDate, when earlier than the lease end", () => {
    const leases = [
      lease({
        Id: 1,
        LeaseFromDate: "2024-07-11",
        LeaseToDate: "2026-06-30",
        MoveOutData: [{ TenantId: 1, MoveOutDate: "2026-06-30", NoticeGivenDate: "2026-04-29" }],
      }),
      lease({ Id: 2, LeaseFromDate: "2026-07-10", LeaseToDate: "2060-01-01" }),
    ];
    const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
    expect(cycles).toEqual([{ propertyId: "100", unitId: "10", start: "2026-04-29", end: "2026-07-10" }]);
  });

  it("uses the EARLIEST notice date across multiple co-tenants on the same lease", () => {
    const leases = [
      lease({
        Id: 1,
        LeaseFromDate: "2024-01-01",
        LeaseToDate: "2026-06-30",
        MoveOutData: [
          { TenantId: 1, MoveOutDate: "2026-06-30", NoticeGivenDate: "2026-05-15" },
          { TenantId: 2, MoveOutDate: "2026-06-30", NoticeGivenDate: "2026-04-29" },
        ],
      }),
      lease({ Id: 2, LeaseFromDate: "2026-07-10", LeaseToDate: "2060-01-01" }),
    ];
    const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
    expect(cycles[0].start).toBe("2026-04-29");
  });

  it("ignores a NoticeGivenDate that's LATER than the lease end (doesn't push the start later than a real, already-known fact)", () => {
    const leases = [
      lease({
        Id: 1,
        LeaseFromDate: "2024-01-01",
        LeaseToDate: "2026-06-30",
        MoveOutData: [{ TenantId: 1, MoveOutDate: "2026-06-30", NoticeGivenDate: "2026-07-05" }],
      }),
    ];
    const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
    expect(cycles[0].start).toBe("2026-06-30");
  });

  it("does not treat a month-to-month lease's sentinel end date as a real vacancy trigger", () => {
    const leases = [lease({ Id: 1, LeaseFromDate: "2023-01-01", LeaseToDate: "2060-01-01" })];
    const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
    expect(cycles).toEqual([]);
  });

  it("does not treat a currently-active lease (no real end date) as a vacancy trigger", () => {
    const leases = [lease({ Id: 1, LeaseFromDate: "2023-01-01", LeaseToDate: null, LeaseStatus: "Active" })];
    const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
    expect(cycles).toEqual([]);
  });

  // CONFIRMED LIVE 2026-07-12: a real bug that shipped a fix for --
  // generated vacancy cycles "starting" in 2027 for units whose CURRENT
  // lease simply runs that long. A real (non-sentinel) LeaseToDate isn't
  // enough on its own to mean a tenant has moved out; it must also have
  // already passed as of asOfDate.
  it("does not treat a currently-active lease's future end date as a vacancy trigger", () => {
    const leases = [lease({ Id: 1, LeaseFromDate: "2026-01-01", LeaseToDate: "2027-09-30", LeaseStatus: "Active" })];
    const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
    expect(cycles).toEqual([]);
  });

  it("skips a same-day or overlapping turnover (no real vacancy gap)", () => {
    const leases = [
      lease({ Id: 1, LeaseFromDate: "2023-01-01", LeaseToDate: "2024-06-01" }),
      lease({ Id: 2, LeaseFromDate: "2024-06-01", LeaseToDate: "2060-01-01" }),
    ];
    const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
    expect(cycles).toEqual([]);
  });

  it("excludes a vacancy that started before the lookback window", () => {
    const leases = [
      lease({ Id: 1, LeaseFromDate: "2015-01-01", LeaseToDate: "2018-01-01" }),
      lease({ Id: 2, LeaseFromDate: "2018-06-01", LeaseToDate: "2060-01-01" }),
    ];
    const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
    expect(cycles).toEqual([]);
  });

  it("finds multiple vacancy cycles across a unit's real lease history", () => {
    const leases = [
      lease({ Id: 1, LeaseFromDate: "2022-01-01", LeaseToDate: "2022-12-31" }),
      lease({ Id: 2, LeaseFromDate: "2023-02-01", LeaseToDate: "2024-06-30" }),
      lease({ Id: 3, LeaseFromDate: "2024-08-01", LeaseToDate: "2060-01-01" }),
    ];
    const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
    expect(cycles).toEqual([
      { propertyId: "100", unitId: "10", start: "2024-06-30", end: "2024-08-01" },
      { propertyId: "100", unitId: "10", start: "2022-12-31", end: "2023-02-01" },
    ]);
  });

  it("closes an ongoing cycle using a real future-dated lease already on file (e.g. a signed but not-yet-started lease)", () => {
    const leases = [
      lease({ Id: 1, LeaseFromDate: "2023-01-01", LeaseToDate: "2026-06-01" }),
      lease({ Id: 2, LeaseFromDate: "2026-08-01", LeaseToDate: "2060-01-01", LeaseStatus: "Future" }),
    ];
    const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
    expect(cycles).toEqual([{ propertyId: "100", unitId: "10", start: "2026-06-01", end: "2026-08-01" }]);
  });

  // CONFIRMED LIVE 2026-07-12: real case, 1149 Birks Lane -- Buildium's
  // own lease history for that unit only goes back to 2024-07-11 (no
  // earlier lease on file at all), yet a real 2024 vacancy is
  // independently confirmed via a real LeadSimple Marketing Process
  // record created 2024-05-17. This describe block covers the new
  // capability that surfaces that vacancy as its own cycle.
  describe("marketing-process-anchored cycle before the earliest known lease", () => {
    it("adds a cycle for the vacancy before the unit's earliest known lease, anchored by a real Marketing Process record", () => {
      const leases = [lease({ Id: 1, LeaseFromDate: "2024-07-11", LeaseToDate: "2026-06-30" })];
      const marketingDates = new Map([["100", ["2024-05-17"]]]);
      const cycles = buildVacancyCycles([unit], leases, new Map(), marketingDates, asOf, 5);
      expect(cycles).toContainEqual({ propertyId: "100", unitId: "10", start: "2024-05-17", end: "2024-07-11" });
    });

    it("does not add a marketing-anchored cycle when no Marketing Process record exists for that property", () => {
      const leases = [lease({ Id: 1, LeaseFromDate: "2024-07-11", LeaseToDate: "2026-06-30" })];
      const cycles = buildVacancyCycles([unit], leases, new Map(), new Map(), asOf, 5);
      expect(cycles.filter((c) => c.end === "2024-07-11")).toEqual([]);
    });

    it("picks the LATEST marketing-process date still before the lease, not an older unrelated one", () => {
      const leases = [lease({ Id: 1, LeaseFromDate: "2024-07-11", LeaseToDate: "2026-06-30" })];
      const marketingDates = new Map([["100", ["2022-01-01", "2024-05-17"]]]);
      const cycles = buildVacancyCycles([unit], leases, new Map(), marketingDates, asOf, 5);
      const anchored = cycles.find((c) => c.end === "2024-07-11");
      expect(anchored?.start).toBe("2024-05-17");
    });

    it("ignores a marketing-process date that's AFTER the lease started (not relevant to this turnover)", () => {
      const leases = [lease({ Id: 1, LeaseFromDate: "2024-07-11", LeaseToDate: "2026-06-30" })];
      const marketingDates = new Map([["100", ["2024-08-01"]]]);
      const cycles = buildVacancyCycles([unit], leases, new Map(), marketingDates, asOf, 5);
      expect(cycles.filter((c) => c.end === "2024-07-11")).toEqual([]);
    });

    it("does not anchor a cycle for a multi-unit property (Marketing Process has no unit-level detail)", () => {
      const otherUnit = { Id: 20, PropertyId: 100 };
      const leases = [lease({ Id: 1, UnitId: 10, LeaseFromDate: "2024-07-11", LeaseToDate: "2026-06-30" })];
      const marketingDates = new Map([["100", ["2024-05-17"]]]);
      const cycles = buildVacancyCycles([unit, otherUnit], leases, new Map(), marketingDates, asOf, 5);
      expect(cycles.filter((c) => c.end === "2024-07-11")).toEqual([]);
    });

    it("respects the lookback cutoff for a marketing-anchored cycle same as any other", () => {
      const leases = [lease({ Id: 1, LeaseFromDate: "2019-07-11", LeaseToDate: "2020-01-01" })];
      const marketingDates = new Map([["100", ["2019-05-17"]]]);
      const cycles = buildVacancyCycles([unit], leases, new Map(), marketingDates, asOf, 5);
      expect(cycles.filter((c) => c.end === "2019-07-11")).toEqual([]);
    });
  });
});

describe("countApplicationsInCycles", () => {
  it("counts an application whose submitted date falls inside a closed cycle's window", () => {
    const cycles = [{ propertyId: "100", unitId: "10", start: "2024-12-31", end: "2025-02-01" }];
    const applicants = [applicant({ Applications: [{ Id: 1, ApplicationStatus: "Approved", ApplicationSubmittedDateTime: "2025-01-15T00:00:00Z" }] })];
    const rows = countApplicationsInCycles(cycles, applicants);
    expect(rows[0].applicationCount).toBe(1);
  });

  it("excludes an application submitted before the cycle started", () => {
    const cycles = [{ propertyId: "100", unitId: "10", start: "2024-12-31", end: "2025-02-01" }];
    const applicants = [applicant({ Applications: [{ Id: 1, ApplicationStatus: "Denied", ApplicationSubmittedDateTime: "2024-06-01T00:00:00Z" }] })];
    expect(countApplicationsInCycles(cycles, applicants)[0].applicationCount).toBe(0);
  });

  it("excludes an application submitted after the cycle ended", () => {
    const cycles = [{ propertyId: "100", unitId: "10", start: "2024-12-31", end: "2025-02-01" }];
    const applicants = [applicant({ Applications: [{ Id: 1, ApplicationStatus: "Withdrawn", ApplicationSubmittedDateTime: "2025-03-01T00:00:00Z" }] })];
    expect(countApplicationsInCycles(cycles, applicants)[0].applicationCount).toBe(0);
  });

  it("counts an application submitted during an ongoing (open-ended) cycle with no upper bound", () => {
    const cycles = [{ propertyId: "100", unitId: "10", start: "2026-06-01", end: null }];
    const applicants = [applicant({ Applications: [{ Id: 1, ApplicationStatus: "New", ApplicationSubmittedDateTime: "2026-07-01T00:00:00Z" }] })];
    expect(countApplicationsInCycles(cycles, applicants)[0].applicationCount).toBe(1);
  });

  it("counts every application status, not just pending ones", () => {
    const cycles = [{ propertyId: "100", unitId: "10", start: "2024-12-31", end: "2025-02-01" }];
    const applicants = [
      applicant({ Id: 1, Status: "Approved", Applications: [{ Id: 1, ApplicationStatus: "Approved", ApplicationSubmittedDateTime: "2025-01-01T00:00:00Z" }] }),
      applicant({ Id: 2, Status: "Denied", Applications: [{ Id: 2, ApplicationStatus: "Denied", ApplicationSubmittedDateTime: "2025-01-05T00:00:00Z" }] }),
    ];
    expect(countApplicationsInCycles(cycles, applicants)[0].applicationCount).toBe(2);
  });

  it("excludes an applicant with no unit assigned yet (can't attribute to a specific vacancy)", () => {
    const cycles = [{ propertyId: "100", unitId: "10", start: "2024-12-31", end: "2025-02-01" }];
    const applicants = [applicant({ UnitId: null, Applications: [{ Id: 1, ApplicationStatus: "New", ApplicationSubmittedDateTime: "2025-01-15T00:00:00Z" }] })];
    expect(countApplicationsInCycles(cycles, applicants)[0].applicationCount).toBe(0);
  });

  it("excludes an applicant on a different unit entirely", () => {
    const cycles = [{ propertyId: "100", unitId: "10", start: "2024-12-31", end: "2025-02-01" }];
    const applicants = [applicant({ UnitId: 99, Applications: [{ Id: 1, ApplicationStatus: "New", ApplicationSubmittedDateTime: "2025-01-15T00:00:00Z" }] })];
    expect(countApplicationsInCycles(cycles, applicants)[0].applicationCount).toBe(0);
  });
});

// ADDED 2026-07-12, per Jason directly: real example, 1149 Birks Lane —
// "1149 Birks Lane, Unit 1, Vacancy 5/17/24-7/11/24, 3 applications,
// Vacancy 4/29/26-7/10/26, 7 applications" as ONE row, oldest vacancy
// first.
describe("groupVacancyRowsByUnit", () => {
  it("groups multiple vacancy cycles for the same unit into one row, newest to oldest", () => {
    const rows = [
      { propertyId: "637727", unitId: "1698497", start: "2024-05-17", end: "2024-07-11", applicationCount: 3 },
      { propertyId: "637727", unitId: "1698497", start: "2026-04-29", end: "2026-07-10", applicationCount: 7 },
    ];
    const grouped = groupVacancyRowsByUnit(rows);
    expect(grouped).toEqual([
      {
        propertyId: "637727",
        unitId: "1698497",
        vacancies: [
          { start: "2026-04-29", end: "2026-07-10", applicationCount: 7 },
          { start: "2024-05-17", end: "2024-07-11", applicationCount: 3 },
        ],
      },
    ]);
  });

  it("keeps two different units as separate rows", () => {
    const rows = [
      { propertyId: "100", unitId: "10", start: "2024-01-01", end: "2024-02-01", applicationCount: 1 },
      { propertyId: "200", unitId: "20", start: "2024-03-01", end: "2024-04-01", applicationCount: 2 },
    ];
    expect(groupVacancyRowsByUnit(rows)).toHaveLength(2);
  });

  it("sorts properties by their most recent vacancy, newest first", () => {
    const rows = [
      { propertyId: "100", unitId: "10", start: "2020-01-01", end: "2020-02-01", applicationCount: 1 },
      { propertyId: "200", unitId: "20", start: "2026-01-01", end: "2026-02-01", applicationCount: 1 },
    ];
    const grouped = groupVacancyRowsByUnit(rows);
    expect(grouped.map((g) => g.unitId)).toEqual(["20", "10"]);
  });

  it("returns a single vacancy unchanged for a unit with only one cycle", () => {
    const rows = [{ propertyId: "100", unitId: "10", start: "2024-01-01", end: "2024-02-01", applicationCount: 5 }];
    expect(groupVacancyRowsByUnit(rows)[0].vacancies).toEqual([{ start: "2024-01-01", end: "2024-02-01", applicationCount: 5 }]);
  });
});
