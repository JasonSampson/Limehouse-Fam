import type { BuildiumLease, BuildiumUnit } from "../buildium/client.js";

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
// FIXED 2026-07-06: this used to derive occupied the same way
// summarizeOccupancy does (has a currently-Active lease) — correct for the
// Occupancy % tile, but confirmed live it does NOT match the vendor's own
// "Vacant — Not Rented" tile (vendor: 22, this gave 8/31 depending on when
// checked). The vendor's Vacant tile uses Buildium's own IsUnitOccupied
// flag directly instead — confirmed by counting both ways against real
// data and matching the vendor's 22 exactly via the flag. This is a real
// inconsistency between the vendor's OWN Occupancy and Vacant tiles (they
// use two different underlying signals), not something introduced here —
// see occupancy.ts's summarizeOccupancy comment for why IsUnitOccupied
// deliberately is NOT used for the Occupancy percentage itself.
export interface UnitStatusRow {
  unitId: string;
  propertyId: string;
  unitNumber: string | null;
  occupied: boolean;
}

export function unitStatusRows(units: BuildiumUnit[]): UnitStatusRow[] {
  return units.map((u) => ({
    unitId: String(u.Id),
    propertyId: String(u.PropertyId),
    unitNumber: u.UnitNumber ?? null,
    occupied: u.IsUnitOccupied,
  }));
}

export function vacantUnitRows(units: BuildiumUnit[]): UnitStatusRow[] {
  return unitStatusRows(units).filter((r) => !r.occupied);
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
  const vacant = vacantUnitRows(units);
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

// Renewal Rate drill-down — ADDED 2026-07-05 alongside the top-of-mind
// Renewal Rate rebuild (see summarizeRenewalRate in occupancy.ts for the
// full formula this mirrors row-by-row, and why it's built this way).
// Reuses the exact same renewed/moved-out classification so the drill-down
// list and the tile's percentage can never disagree with each other.
export interface RenewalRateRow {
  leaseId: string;
  propertyId: string;
  unitNumber: string | null;
  outcome: "renewed" | "moved_out";
  leaseFromDate: string | null;
  leaseToDate: string | null;
  lastUpdatedDateTime: string | null;
}

const RENEWAL_MIN_MOVE_OUT_TERM_DAYS = 300;

export function renewalRateRows(allLeases: BuildiumLease[], asOfDate: Date): RenewalRateRow[] {
  const today = asOfDate.toISOString().slice(0, 10);
  const oneYearAgo = new Date(asOfDate);
  oneYearAgo.setUTCDate(oneYearAgo.getUTCDate() - 365);
  const oneYearAgoStr = oneYearAgo.toISOString().slice(0, 10);

  const rows: RenewalRateRow[] = [];

  for (const lease of allLeases) {
    if (!lease.LeaseFromDate || !lease.LeaseToDate) continue;
    const termDays = Math.round(
      (new Date(lease.LeaseToDate).getTime() - new Date(lease.LeaseFromDate).getTime()) / (1000 * 60 * 60 * 24)
    );

    if (lease.LeaseStatus !== "Past") {
      if (!lease.LastUpdatedDateTime) continue;
      const updatedDate = lease.LastUpdatedDateTime.slice(0, 10);
      if (updatedDate < oneYearAgoStr || updatedDate > today) continue;
      if (termDays > 365) {
        rows.push({
          ...baseRow(lease),
          outcome: "renewed",
          leaseFromDate: lease.LeaseFromDate,
          leaseToDate: lease.LeaseToDate,
          lastUpdatedDateTime: lease.LastUpdatedDateTime,
        });
      }
    } else {
      if (lease.LeaseToDate < oneYearAgoStr || lease.LeaseToDate > today) continue;
      if (termDays >= RENEWAL_MIN_MOVE_OUT_TERM_DAYS) {
        rows.push({
          ...baseRow(lease),
          outcome: "moved_out",
          leaseFromDate: lease.LeaseFromDate,
          leaseToDate: lease.LeaseToDate,
          lastUpdatedDateTime: lease.LastUpdatedDateTime ?? null,
        });
      }
    }
  }

  return rows.sort((a, b) => (b.leaseToDate ?? "").localeCompare(a.leaseToDate ?? ""));
}
