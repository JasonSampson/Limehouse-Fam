import type { BuildiumLease, BuildiumUnit, BuildiumApplicant } from "../buildium/client.js";

// Apps Per Vacancy — ADDED 2026-07-12, per Jason directly. Reconstructs
// each unit's real vacancy history from its own lease record history
// (rather than RentEngine or Buildium's live "listing" record, both of
// which only ever describe a CURRENTLY active listing, never a past one —
// confirmed live against both). A "vacancy cycle" is the gap between one
// lease's real end date and the next lease's start date on the SAME unit.
//
// The cycle's start prefers the EARLIEST of three real signals, since
// real applications for the replacement tenant routinely arrive before
// the outgoing lease's technical end date:
//   1. The outgoing lease's own MoveOutData.NoticeGivenDate — CONFIRMED
//      LIVE 2026-07-12 (real case: 1149 Birks Lane) this is real, weeks
//      before LeaseToDate, and is exactly when 7 real applicants for the
//      replacement tenant actually applied — all of which the original
//      version of this logic (start = LeaseToDate only) silently missed.
//   2. For an ongoing (still-vacant) cycle only: Buildium's real
//      ListingDate, when the unit currently has one.
//   3. The lease's own end date, as the fallback when neither of the
//      above is available.
//
// Separately, a real LeadSimple "04 Marketing Process" record can also
// anchor a WHOLE ADDITIONAL cycle for the vacancy BEFORE the earliest
// lease Buildium has on file for a unit — real case, 1149 Birks Lane: a
// 2024 vacancy with zero Buildium leases on either side of it in this
// account's data, independently confirmed real via a 2024 Marketing
// Process record. This only fires for single-unit properties (a
// Marketing Process only carries a property address, no unit-level
// detail) and can never reach earlier than ~June 2022 for anyone, since
// that's when this LeadSimple workflow itself started being used.
//
// AtWill (month-to-month) leases carry a far-future sentinel LeaseToDate
// ("2060-01-01" — confirmed live, see the Month-to-Month drill-down's own
// note) rather than a real end date; SENTINEL_YEAR_CUTOFF excludes any
// "end" date that far out from being treated as a real vacancy-triggering
// event — a month-to-month tenant hasn't moved out just because Buildium
// stores a placeholder date.
const SENTINEL_YEAR_CUTOFF = "2050-01-01";

function earliestNoticeDate(lease: BuildiumLease): string | null {
  const dates = lease.MoveOutData.map((m) => m.NoticeGivenDate).filter((d): d is string => d !== null);
  return dates.length > 0 ? dates.sort()[0] : null;
}

// Returns whichever of `a`/`b` is earlier, treating a null `b` as "no
// opinion" (keep `a`).
function earlierOf(a: string, b: string | null): string {
  return b !== null && b < a ? b : a;
}

export interface VacancyCycle {
  propertyId: string;
  unitId: string;
  start: string; // "YYYY-MM-DD"
  end: string | null; // null = still vacant today (ongoing)
}

export function buildVacancyCycles(
  units: Pick<BuildiumUnit, "Id" | "PropertyId">[],
  leases: BuildiumLease[],
  listingDateByUnitId: Map<string, string>,
  marketingProcessDatesByPropertyId: Map<string, string[]>,
  asOfDate: Date,
  lookbackYears: number
): VacancyCycle[] {
  const cutoff = new Date(asOfDate);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - lookbackYears);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const todayStr = asOfDate.toISOString().slice(0, 10);

  const leasesByUnit = new Map<number, BuildiumLease[]>();
  for (const l of leases) {
    const list = leasesByUnit.get(l.UnitId) ?? [];
    list.push(l);
    leasesByUnit.set(l.UnitId, list);
  }

  // ADDED 2026-07-12, per Jason directly: real case, 1149 Birks Lane —
  // Buildium's own lease history for a unit doesn't always reach back as
  // far as the property's real management history (confirmed live: only
  // 2 leases on file there, starting 2024, even though a real 2024
  // vacancy — with 0 Buildium leases on either side of it in our data —
  // is independently confirmed by a real LeadSimple Marketing Process
  // record). Only applied to single-unit properties: LeadSimple's process
  // only carries a property address, no unit-level detail, so a
  // multi-unit property's vacancy can't be confidently attributed to one
  // specific unit.
  const unitCountByProperty = new Map<number, number>();
  for (const u of units) unitCountByProperty.set(u.PropertyId, (unitCountByProperty.get(u.PropertyId) ?? 0) + 1);

  const cycles: VacancyCycle[] = [];
  for (const unit of units) {
    const unitLeases = (leasesByUnit.get(unit.Id) ?? [])
      .filter((l) => l.LeaseFromDate !== null)
      .sort((a, b) => a.LeaseFromDate!.localeCompare(b.LeaseFromDate!));

    if (unitLeases.length > 0 && unitCountByProperty.get(unit.PropertyId) === 1) {
      const firstLease = unitLeases[0];
      const marketingDates = marketingProcessDatesByPropertyId.get(String(unit.PropertyId)) ?? [];
      // the LATEST marketing-process date still before this lease started
      // -- the marketing effort that actually led into it, not an even
      // older one for a prior, already-accounted-for turnover.
      const priorDates = marketingDates.filter((d) => d < firstLease.LeaseFromDate!);
      if (priorDates.length > 0) {
        const start = priorDates[priorDates.length - 1];
        if (start >= cutoffStr) {
          cycles.push({ propertyId: String(unit.PropertyId), unitId: String(unit.Id), start, end: firstLease.LeaseFromDate });
        }
      }
    }

    for (let i = 0; i < unitLeases.length; i++) {
      const current = unitLeases[i];
      const currentEnd = current.LeaseToDate;
      // FIXED 2026-07-12: a real (non-sentinel) end date isn't enough on
      // its own -- CONFIRMED LIVE this was generating vacancy cycles that
      // "started" in 2027 for units whose CURRENT lease simply runs that
      // long, i.e. the tenant hasn't moved out yet. A lease only triggers
      // a vacancy once its end date has actually passed.
      const hasRealEnd = currentEnd !== null && currentEnd < SENTINEL_YEAR_CUTOFF && currentEnd <= todayStr;
      if (!hasRealEnd) continue; // still occupied (month-to-month, no end on file, or hasn't ended yet) -- no vacancy starts here

      const next = unitLeases[i + 1];
      const cycleEnd = next ? next.LeaseFromDate! : null;

      // a same-day or overlapping turnover isn't a real vacancy gap
      if (cycleEnd !== null && cycleEnd <= currentEnd) continue;

      let start = earlierOf(currentEnd, earliestNoticeDate(current));
      if (cycleEnd === null) {
        start = earlierOf(start, listingDateByUnitId.get(String(unit.Id)) ?? null);
      }

      if (start < cutoffStr) continue; // outside the lookback window

      cycles.push({ propertyId: String(unit.PropertyId), unitId: String(unit.Id), start, end: cycleEnd });
    }
  }

  return cycles.sort((a, b) => b.start.localeCompare(a.start));
}

export interface VacancyApplicationRow extends VacancyCycle {
  applicationCount: number;
}

// Only applicants with a real UnitId are attributed to a specific unit's
// vacancy cycle — an applicant with no unit assigned yet is a genuine gap
// (can't confidently say which of a multi-unit property's vacancies they
// belong to), excluded rather than guessed.
export function countApplicationsInCycles(
  cycles: VacancyCycle[],
  applicants: BuildiumApplicant[]
): VacancyApplicationRow[] {
  const applicantsByUnit = new Map<string, BuildiumApplicant[]>();
  for (const a of applicants) {
    if (a.UnitId === null) continue;
    const key = String(a.UnitId);
    const list = applicantsByUnit.get(key) ?? [];
    list.push(a);
    applicantsByUnit.set(key, list);
  }

  return cycles.map((cycle) => {
    const candidateApplicants = applicantsByUnit.get(cycle.unitId) ?? [];
    const applicationCount = candidateApplicants.filter((a) =>
      a.Applications.some((app) => {
        if (app.ApplicationSubmittedDateTime === null) return false;
        const submittedDate = app.ApplicationSubmittedDateTime.slice(0, 10);
        return submittedDate >= cycle.start && (cycle.end === null || submittedDate <= cycle.end);
      })
    ).length;
    return { ...cycle, applicationCount };
  });
}

export interface VacancyOnly {
  start: string;
  end: string | null;
  applicationCount: number;
}

export interface GroupedVacancyRow {
  propertyId: string;
  unitId: string;
  vacancies: VacancyOnly[]; // newest to oldest
}

// Groups the flat per-cycle rows into one row per unit — ADDED 2026-07-12,
// per Jason directly: he wants one property/unit shown once, with all of
// its real vacancies laid out in that same row, rather than a separate
// table row per vacancy. Within a row, vacancies go newest to oldest (most
// recent vacancy first) — per Jason directly, so the freshest activity is
// always the first column. Properties are then sorted by their MOST RECENT
// vacancy's start date, newest first, so whichever property had activity
// most recently surfaces at the top — same intent the un-grouped list
// already had.
export function groupVacancyRowsByUnit(rows: VacancyApplicationRow[]): GroupedVacancyRow[] {
  const byUnit = new Map<string, GroupedVacancyRow>();
  for (const r of rows) {
    const vacancy: VacancyOnly = { start: r.start, end: r.end, applicationCount: r.applicationCount };
    const existing = byUnit.get(r.unitId);
    if (existing) {
      existing.vacancies.push(vacancy);
    } else {
      byUnit.set(r.unitId, { propertyId: r.propertyId, unitId: r.unitId, vacancies: [vacancy] });
    }
  }

  const grouped = [...byUnit.values()];
  for (const g of grouped) g.vacancies.sort((a, b) => b.start.localeCompare(a.start));
  grouped.sort((a, b) => b.vacancies[0].start.localeCompare(a.vacancies[0].start));
  return grouped;
}
