import type { BuildiumProperty } from "../buildium/client.js";

// Shared row-enrichment helpers for Dashboard drill-downs. Every drill-down
// row so far has only ever carried Buildium's raw internal propertyId (e.g.
// "650473") — CONFIRMED LIVE 2026-07-06 that the vendor dashboard instead
// shows the real street address ("3016 North Lynnhaven Road"). These
// helpers resolve that address (and, separately, a lease's unit number
// where the row didn't already carry one) as a join at the route layer,
// keeping the row-builder functions in leaseRows.ts/occupancy.ts/etc. pure
// and untouched.
export function propertyAddressById(properties: BuildiumProperty[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of properties) {
    if (p.Address.AddressLine1) map.set(String(p.Id), p.Address.AddressLine1);
  }
  return map;
}

export function withPropertyAddress<T extends { propertyId: string }>(
  rows: T[],
  addressesByPropertyId: Map<string, string>
): (T & { propertyAddress: string | null })[] {
  return rows.map((r) => ({ ...r, propertyAddress: addressesByPropertyId.get(r.propertyId) ?? null }));
}

// Only needed for row types that don't already carry a unit number directly
// from their source lease/unit object (currently just the Delinquency
// drill-down, which is built from /leases/outstandingbalances — that
// endpoint has no unit info at all).
export function unitNumberByLeaseId(leases: { Id: number; UnitNumber: string | null }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const l of leases) {
    if (l.UnitNumber) map.set(String(l.Id), l.UnitNumber);
  }
  return map;
}

export function withUnitNumber<T extends { leaseId: string }>(
  rows: T[],
  unitNumbersByLeaseId: Map<string, string>
): (T & { unitNumber: string | null })[] {
  return rows.map((r) => ({ ...r, unitNumber: unitNumbersByLeaseId.get(r.leaseId) ?? null }));
}
