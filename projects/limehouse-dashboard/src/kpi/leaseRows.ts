import type { BuildiumLease, BuildiumUnit } from "../buildium/client.js";
import type { LeaseDepositWithheld, MoveOutWindow } from "./rentCollection.js";

// Shared row-shaping helpers for Dashboard tab drill-downs. Kept as pure
// functions over plain lease/unit arrays (no fetching, no Date.now() other
// than an explicit asOfDate param) so each is trivially unit-testable, same
// pattern as everything else in src/kpi/. Column shape intentionally
// matches the existing drill-downs already shipped (delinquentLeaseRows,
// upcomingRenewals): propertyId/leaseId as plain identifiers, not resolved
// property names — the frontend doesn't currently resolve property names
// for any drill-down, and adding that is a separate, larger change (a
// property-name lookup join) not part of this batch.

export interface LeaseRow {
  leaseId: string;
  propertyId: string;
  unitNumber: string | null;
  tenantName: string | null;
}

function tenantName(lease: BuildiumLease): string | null {
  const tenants = lease.CurrentTenants ?? [];
  if (tenants.length === 0) return null;
  return tenants
    .map((t) => `${t.FirstName ?? ""} ${t.LastName ?? ""}`.trim())
    .filter((n) => n.length > 0)
    .join(", ") || null;
}

function baseRow(lease: BuildiumLease): LeaseRow {
  return {
    leaseId: String(lease.Id),
    propertyId: String(lease.PropertyId),
    unitNumber: lease.UnitNumber,
    tenantName: tenantName(lease),
  };
}

// Avg Rent/Lease drill-down: active leases with rent amount. Excludes
// leases with no known rent (AccountDetails.Rent null) rather than showing
// a fake $0 row, matching summarizeRentAndDeposit's own null-filtering.
export interface RentLeaseRow extends LeaseRow {
  rent: number;
}

export function rentLeaseRows(activeLeases: BuildiumLease[]): RentLeaseRow[] {
  return activeLeases
    .filter((l) => typeof l.AccountDetails?.Rent === "number")
    .map((l) => ({ ...baseRow(l), rent: l.AccountDetails!.Rent as number }))
    .sort((a, b) => b.rent - a.rent);
}

// Fixed-Term / Month-to-Month drill-downs — same LeaseType classification
// summarizeLeaseMix already uses (Fixed/FixedWithRollover = fixed-term,
// AtWill = month-to-month).
export interface LeaseTypeRow extends LeaseRow {
  leaseFromDate: string | null;
  leaseToDate: string | null;
}

export function fixedTermLeaseRows(activeLeases: BuildiumLease[]): LeaseTypeRow[] {
  return activeLeases
    .filter((l) => l.LeaseType === "Fixed" || l.LeaseType === "FixedWithRollover")
    .map((l) => ({ ...baseRow(l), leaseFromDate: l.LeaseFromDate, leaseToDate: l.LeaseToDate }));
}

export function monthToMonthLeaseRows(activeLeases: BuildiumLease[]): LeaseTypeRow[] {
  return activeLeases
    .filter((l) => l.LeaseType === "AtWill")
    .map((l) => ({ ...baseRow(l), leaseFromDate: l.LeaseFromDate, leaseToDate: l.LeaseToDate }));
}

// Evictions Pending drill-down.
export function evictionPendingLeaseRows(activeLeases: BuildiumLease[]): LeaseRow[] {
  return activeLeases.filter((l) => l.IsEvictionPending).map(baseRow);
}

// Avg Tenancy drill-down: active leases with tenancy length in months,
// measured the same way averageTenancyMonths computes the summary (from
// LeaseFromDate to asOfDate, not to LeaseToDate — see occupancy.ts for why).
export interface TenancyRow extends LeaseRow {
  tenancyMonths: number;
}

export function tenancyRows(activeLeases: BuildiumLease[], asOfDate: Date): TenancyRow[] {
  return activeLeases
    .filter((l) => l.LeaseFromDate !== null)
    .map((l) => {
      const days = (asOfDate.getTime() - new Date(l.LeaseFromDate as string).getTime()) / (1000 * 60 * 60 * 24);
      const tenancyMonths = Math.round(Math.max(days / 30.44, 0) * 10) / 10;
      return { ...baseRow(l), tenancyMonths };
    })
    .sort((a, b) => b.tenancyMonths - a.tenancyMonths);
}

// Move-Ins drill-down AND summary count: leases whose LeaseFromDate falls
// within the selected period — this is a FLOW metric (respects the period
// selector), unlike most of the other rows above which are structural
// (as-of-today). Previously this tile was hardcoded to "Not connected
// yet" even though it's fully computable from data already fetched
// elsewhere on this dashboard (fetchLeasesByStatus) — no new endpoint
// needed, just never wired up.
export function moveInLeaseRows(activeLeases: BuildiumLease[], fromDate: string, toDate: string): LeaseRow[] {
  const fromMs = new Date(fromDate).getTime();
  const toMs = new Date(toDate).getTime();
  return activeLeases
    .filter((l) => {
      if (!l.LeaseFromDate) return false;
      const ms = new Date(l.LeaseFromDate).getTime();
      return ms >= fromMs && ms <= toMs;
    })
    .map(baseRow);
}

// Total Units / Vacant — Not Rented drill-downs: every tracked unit with
// its occupied/vacant status.
//
// FIXED 2026-07-06, REVERTED 2026-07-09: briefly matched the vendor's
// "Vacant — Not Rented" tile by using Buildium's own IsUnitOccupied flag
// directly (matched their 22 exactly at the time). Confirmed live
// 2026-07-09 against the vendor's OWN "Avg Days Vacant" drill-down that
// the flag lags real lease-status transitions by up to ~2 weeks: 12 units
// whose most recent lease had already ended (LeaseStatus "Past", real
// move-out) still showed IsUnitOccupied=true in Buildium — undercounting
// real vacancies by 12 (19 vs. the true 31). Same lagging-flag problem
// summarizeOccupancy's own comment already documented for the Occupancy %
// tile — this now uses the same fix (occupied = has a currently-Active
// lease attached), per Jason directly, so Total Units/Vacant/Avg Days
// Vacant all agree with Occupancy % on what "occupied" means.
export interface UnitStatusRow {
  unitId: string;
  propertyId: string;
  unitNumber: string | null;
  occupied: boolean;
}

export function unitStatusRows(units: BuildiumUnit[], activeLeases: BuildiumLease[]): UnitStatusRow[] {
  const occupiedUnitIds = new Set(activeLeases.map((l) => l.UnitId));
  return units.map((u) => ({
    unitId: String(u.Id),
    propertyId: String(u.PropertyId),
    unitNumber: u.UnitNumber ?? null,
    occupied: occupiedUnitIds.has(u.Id),
  }));
}

export function vacantUnitRows(units: BuildiumUnit[], activeLeases: BuildiumLease[]): UnitStatusRow[] {
  return unitStatusRows(units, activeLeases).filter((r) => !r.occupied);
}

// Avg Days Vacant: for each currently-vacant unit, how many days since its
// most recent lease ended (LeaseToDate) — or null if the unit has never had
// a lease on file at all (can't compute a "days vacant" for a unit with no
// lease history; excluded from the average rather than guessed as 0,
// same "gap is visible, not silently misclassified" rule used elsewhere).
// This reuses the SAME real-data pattern Q already verified for the
// Doors Lost estimate (most-recent-LeaseToDate as the vacancy-start proxy)
// rather than inventing a new one — Buildium has no "date unit became
// vacant" field either, this is the same kind of derived-from-lease-
// history estimate.
export interface VacantUnitDaysRow {
  unitId: string;
  propertyId: string;
  unitNumber: string | null;
  daysVacant: number | null;
  lastLeaseToDate: string | null;
}

export function vacantUnitDaysRows(units: BuildiumUnit[], allLeases: BuildiumLease[], asOfDate: Date): VacantUnitDaysRow[] {
  const activeLeases = allLeases.filter((l) => l.LeaseStatus === "Active");
  const vacant = vacantUnitRows(units, activeLeases);
  const leasesByUnit = new Map<number, BuildiumLease[]>();
  for (const l of allLeases) {
    const bucket = leasesByUnit.get(l.UnitId);
    if (bucket) bucket.push(l);
    else leasesByUnit.set(l.UnitId, [l]);
  }

  return vacant.map((v) => {
    const unitLeases = leasesByUnit.get(Number(v.unitId)) ?? [];
    const pastEndDates = unitLeases
      .map((l) => l.LeaseToDate)
      .filter((d): d is string => d !== null)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
    const lastLeaseToDate = pastEndDates[0] ?? null;
    const daysVacant = lastLeaseToDate
      ? Math.max(Math.round((asOfDate.getTime() - new Date(lastLeaseToDate).getTime()) / (1000 * 60 * 60 * 24)), 0)
      : null;
    return { unitId: v.unitId, propertyId: v.propertyId, unitNumber: v.unitNumber, daysVacant, lastLeaseToDate };
  });
}

export function averageDaysVacant(rows: VacantUnitDaysRow[]): number | null {
  const known = rows.map((r) => r.daysVacant).filter((d): d is number => d !== null);
  if (known.length === 0) return null;
  return Math.round(known.reduce((sum, d) => sum + d, 0) / known.length);
}

// Renewal Rate drill-down — ADDED 2026-07-05, REBUILT 2026-07-07 alongside
// the top-of-mind Renewal Rate rebuild (see summarizeRenewalRate in
// occupancy.ts for the full formula this mirrors row-by-row, and why it's
// built this way). Reuses the exact same renewed/moved-out classification
// so the drill-down list and the tile's percentage can never disagree.
//
// fromDate now means different things per outcome, matching what the
// vendor's own drill-down actually shows: for a renewed lease it's the
// Rent recurring-charge's effective date (when THIS renewal took effect),
// NOT the lease's original move-in date — for a moved-out lease there's no
// rent-schedule concept to check anymore, so it falls back to the lease's
// real LeaseFromDate.
export interface RenewalRateRow {
  leaseId: string;
  propertyId: string;
  unitNumber: string | null;
  outcome: "renewed" | "moved_out";
  fromDate: string | null;
  toDate: string | null;
}

const RENEWAL_MIN_MOVE_OUT_TERM_DAYS = 300;

export function renewalRateRows(
  allLeases: BuildiumLease[],
  rentEffectiveDateByLeaseId: Map<string, string>,
  asOfDate: Date
): RenewalRateRow[] {
  const today = asOfDate.toISOString().slice(0, 10);
  const oneYearAgo = new Date(asOfDate);
  oneYearAgo.setUTCDate(oneYearAgo.getUTCDate() - 365);
  const oneYearAgoStr = oneYearAgo.toISOString().slice(0, 10);

  const rows: RenewalRateRow[] = [];

  // ATTEMPTED 2026-07-07, REVERTED — see summarizeRenewalRate in
  // occupancy.ts for the full story: tried reclassifying a Past lease as
  // renewed based on a same-unit successor lease starting within 45 days,
  // but at full portfolio scale this matched unrelated leases across
  // different years and badly overcounted. Reverted to the simpler,
  // well-supported term-length floor below.
  for (const lease of allLeases) {
    if (lease.LeaseStatus !== "Past") {
      const rentDate = rentEffectiveDateByLeaseId.get(String(lease.Id));
      if (!rentDate) continue;
      // A brand-new lease's very first rent charge ALSO creates a Rent
      // recurring-transaction entry dated to move-in — that's not a
      // renewal, it's day one. Requiring at least 180 days between move-in
      // and the rent-effective date safely clears any proration quirk
      // while still catching every real renewal.
      if (lease.LeaseFromDate && Math.round((new Date(rentDate).getTime() - new Date(lease.LeaseFromDate).getTime()) / (1000 * 60 * 60 * 24)) < 180)
        continue;
      // No upper bound — already-scheduled future rent increases still
      // count as this year's renewal.
      if (rentDate < oneYearAgoStr) continue;
      rows.push({
        ...baseRow(lease),
        outcome: "renewed",
        fromDate: rentDate,
        toDate: lease.LeaseToDate,
      });
      continue;
    }
    if (!lease.LeaseFromDate || !lease.LeaseToDate) continue;
    const termDays = Math.round(
      (new Date(lease.LeaseToDate).getTime() - new Date(lease.LeaseFromDate).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (lease.LeaseToDate < oneYearAgoStr || lease.LeaseToDate > today) continue;
    if (termDays >= RENEWAL_MIN_MOVE_OUT_TERM_DAYS) {
      rows.push({
        ...baseRow(lease),
        outcome: "moved_out",
        fromDate: lease.LeaseFromDate,
        toDate: lease.LeaseToDate,
      });
    }
  }

  return rows.sort((a, b) => (b.toDate ?? "").localeCompare(a.toDate ?? ""));
}

// Avg SD Withheld drill-down — REBUILT 2026-07-10, matching the vendor's
// own real methodology (see summarizeSecurityDepositWithheld in
// rentCollection.ts for the full derivation). One row per Past lease that:
//   1. moved out within the vendor's real window (13 months ago through 30
//      days ago — recent enough to matter, old enough that Limehouse has
//      actually posted the reconciliation),
//   2. has a known original deposit amount, and
//   3. has at least one real move-out reconciliation transaction (not just
//      any "Applied Deposit" — see extractSecurityDepositWithheld).
// `withheld` here is already CAPPED at the lease's own deposit — a
// withheld amount can never exceed what was actually collected.
export interface SecurityDepositWithheldRow extends LeaseRow {
  moveOutDate: string; // "YYYY-MM-DD"
  securityDeposit: number;
  withheld: number; // capped at securityDeposit
  percent: number; // withheld / securityDeposit * 100, this lease only
}

export function securityDepositWithheldRows(
  pastLeases: BuildiumLease[],
  withheldByLeaseId: Map<string, LeaseDepositWithheld>,
  window: MoveOutWindow
): SecurityDepositWithheldRow[] {
  const rows: SecurityDepositWithheldRow[] = [];

  for (const lease of pastLeases) {
    if (!lease.LeaseToDate) continue;
    if (lease.LeaseToDate < window.start || lease.LeaseToDate > window.end) continue;

    const deposit = lease.AccountDetails?.SecurityDeposit;
    if (typeof deposit !== "number" || deposit <= 0) continue; // no known deposit amount — can't compute a percent

    const info = withheldByLeaseId.get(String(lease.Id));
    if (!info || !info.hasQualifyingEntry) continue; // no real move-out reconciliation posted yet — excluded, not shown as $0

    const withheld = Math.min(info.withheld, deposit); // capped — see summarizeSecurityDepositWithheld's note on why
    rows.push({
      ...baseRow(lease),
      moveOutDate: lease.LeaseToDate,
      securityDeposit: deposit,
      withheld,
      percent: Math.round((withheld / deposit) * 1000) / 10,
    });
  }

  return rows.sort((a, b) => b.percent - a.percent);
}
