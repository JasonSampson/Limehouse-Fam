import type { BuildiumTenantWithLeases } from "../buildium/client.js";

// Avg Tenancy — REBUILT 2026-07-12, per Jason directly: "I want to know the
// average length of tenancy for every past and current tenant," measured
// "up to today's date" for anyone still living there — explicitly NOT to a
// current lease's contract end date (LeaseToDate), since a tenant can
// terminate early and that date isn't a real signal of how long they'll
// actually stay.
//
// Source is fetchAllTenantsWithLeases() (Buildium's real /leases/tenants
// endpoint) rather than fetchAllLeases() — see that function's own comment
// for why: CurrentTenants (used by every other drill-down on this
// dashboard) goes empty the moment a lease turns Past, so it can never
// answer "who lived here historically." Each lease's own Tenants[] array
// (Status + a real per-tenant MoveInDate) and MoveOutData[] (a real
// per-tenant MoveOutDate) are the only fields that carry that history.
//
// Real tenants are grouped by (tenantId, unitId) — CONFIRMED LIVE 31 of 931
// real tenants on this account appear on more than one lease record. Most
// of those are the same tenant renting a DIFFERENT unit at a different
// time (two unrelated tenancies — kept as two separate rows here). A
// handful are the same tenant on the SAME unit across two lease records
// (e.g. moved out, then moved back into the same unit years later) — those
// are merged into one row using the earliest move-in and latest move-out
// across the group, per Jason directly ("treat each unit they've lived in
// as its own separate tenancy").
//
// A per-lease "Current" Tenants[] entry is only trusted if that lease's own
// CurrentTenants also includes the tenant — see the GHOST-CURRENT GUARD
// below for why: FIXED 2026-07-13, Jason spotted real tenants showing
// "Current" years after they'd actually left.
export interface TenantStayRow {
  tenantId: string;
  tenantName: string | null;
  propertyId: string;
  unitId: string;
  unitNumber: string | null;
  movedIn: string; // "YYYY-MM-DD"
  movedOut: string | null; // null = still there (current tenant)
  tenancyMonths: number;
}

function monthsBetween(fromDateStr: string, to: Date): number {
  const days = (to.getTime() - new Date(fromDateStr).getTime()) / (1000 * 60 * 60 * 24);
  return Math.max(days / 30.44, 0); // 30.44 = average days/month across a year, avoids calendar-month edge cases
}

// AtWill (month-to-month) leases carry a far-future sentinel LeaseToDate
// ("2060-01-01") rather than a real end date — same convention as the Apps
// Per Vacancy rebuild (src/kpi/vacancyApplications.ts).
const SENTINEL_YEAR_CUTOFF = "2050-01-01";

interface TenantUnitGroup {
  tenantId: number;
  tenantName: string | null;
  propertyId: number;
  unitId: number;
  unitNumber: string | null;
  moveIns: string[];
  moveOuts: string[];
  statuses: Array<"Current" | "MovedOut" | "Future">;
}

export function buildTenantStayRows(tenants: BuildiumTenantWithLeases[], asOfDate: Date): TenantStayRow[] {
  const todayStr = asOfDate.toISOString().slice(0, 10);
  const groups = new Map<string, TenantUnitGroup>();

  for (const tenant of tenants) {
    const tenantName = [tenant.FirstName, tenant.LastName].filter((n): n is string => !!n).join(" ") || null;
    for (const lease of tenant.Leases) {
      const tenantOnLease = lease.Tenants.find((t) => t.Id === tenant.Id);
      if (!tenantOnLease || tenantOnLease.MoveInDate === null) continue; // no real move-in signal — skip rather than guess

      // GHOST-CURRENT GUARD — FIXED 2026-07-13, per Jason directly: he
      // spotted real tenants (Neil Strom, Stine Strom, Michael MacQuarrie,
      // Laramie Jamison) showing as "Current" years after they'd actually
      // left. CONFIRMED LIVE the cause: Buildium's own CurrentTenants field
      // (this dashboard's ground truth for "who's actually there right
      // now" everywhere else — occupancy, delinquency, every other
      // drill-down) does NOT include these tenants, even though
      // Tenants[].Status still says "Current" — the same stale-Active-flag
      // ghost-lease bug fetchActiveLeases() already works around (real
      // case: lease 774300, LeaseStatus stuck "Active", LeaseToDate
      // 2018-04-22, CurrentTenants empty, zero MoveOutData). Affects 52 of
      // 403 "Current" tenant records account-wide, confirmed live — not
      // just the 4 Jason happened to spot. A ghost "Current" record falls
      // back to its own lease's real LeaseToDate as the best available end
      // signal (CONFIRMED LIVE all 52 have one); with no usable LeaseToDate
      // it would be skipped entirely rather than guessed, though that case
      // doesn't currently occur.
      let status = tenantOnLease.Status;
      let ghostMoveOut: string | null = null;
      if (status === "Current" && !(lease.CurrentTenants ?? []).some((ct) => ct.Id === tenant.Id)) {
        if (lease.LeaseToDate !== null && lease.LeaseToDate < SENTINEL_YEAR_CUTOFF && lease.LeaseToDate <= todayStr) {
          status = "MovedOut";
          ghostMoveOut = lease.LeaseToDate;
        } else {
          continue; // no trustworthy "current" signal AND no usable fallback end date — skip rather than guess
        }
      }

      const key = `${tenant.Id}:${lease.UnitId}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          tenantId: tenant.Id,
          tenantName,
          propertyId: lease.PropertyId,
          unitId: lease.UnitId,
          unitNumber: lease.UnitNumber,
          moveIns: [],
          moveOuts: [],
          statuses: [],
        };
        groups.set(key, group);
      }
      group.moveIns.push(tenantOnLease.MoveInDate);
      group.statuses.push(status);
      if (status === "MovedOut") {
        const moveOut = ghostMoveOut ?? lease.MoveOutData.find((m) => m.TenantId === tenant.Id)?.MoveOutDate;
        if (moveOut) group.moveOuts.push(moveOut);
      }
    }
  }

  const rows: TenantStayRow[] = [];
  for (const group of groups.values()) {
    if (group.statuses.every((s) => s === "Future")) continue; // hasn't actually moved in yet — not "past or current"

    const movedIn = [...group.moveIns].sort()[0];
    const isCurrent = group.statuses.includes("Current");
    const movedOut = isCurrent ? null : ([...group.moveOuts].sort().at(-1) ?? null);
    if (!isCurrent && movedOut === null) continue; // MovedOut with no real MoveOutDate on file — gap is visible, not guessed

    const end = isCurrent ? asOfDate : new Date(movedOut as string);
    const tenancyMonths = Math.round(monthsBetween(movedIn, end) * 10) / 10;

    rows.push({
      tenantId: String(group.tenantId),
      tenantName: group.tenantName,
      propertyId: String(group.propertyId),
      unitId: String(group.unitId),
      unitNumber: group.unitNumber,
      movedIn,
      movedOut,
      tenancyMonths,
    });
  }

  return rows.sort((a, b) => b.tenancyMonths - a.tenancyMonths);
}

export function averageTenantTenancyMonths(rows: TenantStayRow[]): number | null {
  if (rows.length === 0) return null;
  const avg = rows.reduce((sum, r) => sum + r.tenancyMonths, 0) / rows.length;
  return Math.round(avg * 10) / 10;
}
