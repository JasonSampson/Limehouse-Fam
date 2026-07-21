import type { Pool } from "pg";
import { getAppPool } from "../db/pool.js";
import { getSignedPhotoUrls } from "./photoUrls.js";
import { isPointInPolygon, validateBoundary, type LatLng } from "./pointInPolygon.js";

// ------------------------------------------------------------------ //
// Shared helpers                                                      //
// ------------------------------------------------------------------ //

/** Resolves LimeHQ display names for a set of user ids that live in
 * public.users — a table Map's own pool (map_staff_app) cannot see, by
 * design (schema.md's two-way fence). Anything that needs to show "who
 * flagged this" / "who activated this" calls this against getAppPool()
 * instead, and joins in application code. */
async function resolveDisplayNames(
  userIds: Array<string | number | null | undefined>,
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  // Every id this function receives is a bigint FK (flagged_by_user_id,
  // created_by_user_id, etc.) — node-postgres returns bigint columns as
  // strings, not numbers, to avoid silent precision loss on values bigger
  // than Number.MAX_SAFE_INTEGER. Real user ids are well under that range,
  // so Number(...) is safe here; filter nulls out BEFORE converting (
  // Number(null) is 0, which would otherwise masquerade as a real id).
  const ids = [
    ...new Set(
      userIds.filter((id): id is string | number => id !== null && id !== undefined).map(Number),
    ),
  ].filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return map;
  const pool = getAppPool();
  const result = await pool.query<{ id: number; display_name: string }>(
    `SELECT id, display_name FROM users WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  for (const row of result.rows) map.set(Number(row.id), row.display_name);
  return map;
}

// ------------------------------------------------------------------ //
// Pins + popup data                                                   //
// ------------------------------------------------------------------ //

export interface MapTenant {
  fullName: string;
  phone: string | null;
  isPrimary: boolean;
}

export interface MapRecurringCharge {
  label: string;
  amount: string;
}

export interface MapUnit {
  id: number;
  unitLabel: string;
  bedrooms: number | null;
  bathrooms: string | null;
  squareFeet: number | null;
  leaseStatus: "Active" | "Future" | null;
  leaseFrom: string | null;
  leaseTo: string | null;
  currentRent: string | null;
  askingRent: string | null;
  isVacant: boolean;
  tenants: MapTenant[];
  // Recurring charges beyond base rent — utilities, etc. Already filtered to
  // excluded_from_display = false (e.g. "Resident Benefits Package" is
  // synced but never reaches here — see src/lib/feeClassification.ts in
  // projects/map). Empty array, not null, when there are none.
  recurringCharges: MapRecurringCharge[];
}

export interface MapExclusion {
  id: number;
  reasonCode: string;
  flaggedByName: string;
  flaggedAt: string;
  incidentReport: string | null;
  reviewBy: string | null;
}

export interface MapProperty {
  id: number;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  latitude: number;
  longitude: number;
  photoUrl: string | null;
  units: MapUnit[];
  exclusion: MapExclusion | null;
}

const REASON_CODE_LABELS: Record<string, string> = {
  structure_condition: "Structure age/condition",
  never_renovated: "Never renovated",
  too_far_to_service: "Too far to service efficiently",
  past_operational_problems: "Past operational problems",
  staff_safety_concern: "Documented staff-safety incident",
};

export function reasonCodeLabel(code: string): string {
  return REASON_CODE_LABELS[code] ?? code;
}

/**
 * Every currently-active, geocoded property, with its units, current-or-
 * future lease, tenants, primary photo, and any active "do not pursue" flag
 * — everything the internal map's pins and popups need, fetched in one
 * batch of small queries rather than one giant multi-table join (this
 * portfolio is ~230 units; a handful of separate queries joined in
 * application code is simpler to read and reason about than one query
 * producing a fan-out of duplicate rows).
 */
export async function fetchActiveMapProperties(pool: Pool): Promise<MapProperty[]> {
  const propertiesResult = await pool.query<{
    id: number;
    address_line1: string;
    address_line2: string | null;
    city: string;
    state: string;
    postal_code: string;
    latitude: string;
    longitude: string;
  }>(
    `SELECT id, address_line1, address_line2, city, state, postal_code, latitude, longitude
     FROM properties
     WHERE is_active = true AND geocode_status = 'ok'
       AND latitude IS NOT NULL AND longitude IS NOT NULL
     ORDER BY city, address_line1`,
  );
  const propertyIds = propertiesResult.rows.map((r) => r.id);
  if (propertyIds.length === 0) return [];

  // NOTE on bigint columns below: property_id/unit_id/lease_id/*_user_id are
  // all `bigint` in the schema, and node-postgres returns bigint values as
  // JS strings (not numbers) to avoid silent precision loss. `properties.id`/
  // `units.id`/`leases.id` are `serial` (plain integer), which pg DOES return
  // as a JS number. Every Map below is keyed by a bigint value, so it's built
  // with an explicit Number(...) conversion at insert time — without that,
  // `"98" !== 98` and every .get(serialIdNumber) lookup silently misses.
  const [unitsResult, photosResult, exclusionsResult] = await Promise.all([
    pool.query<{
      id: number;
      property_id: string;
      unit_label: string;
      bedrooms: number | null;
      bathrooms: string | null;
      square_feet: number | null;
    }>(
      `SELECT id, property_id, unit_label, bedrooms, bathrooms, square_feet
       FROM units WHERE property_id = ANY($1::bigint[]) ORDER BY unit_label`,
      [propertyIds],
    ),
    pool.query<{ property_id: string; storage_bucket: string; storage_path: string }>(
      `SELECT property_id, storage_bucket, storage_path
       FROM property_photos WHERE property_id = ANY($1::bigint[]) AND is_primary = true`,
      [propertyIds],
    ),
    // property_exclusions_effective already accounts for auto-expiry
    // (review_by in the past no longer counts as "currently flagged") —
    // migration 0013's own computed-view philosophy, reused here rather
    // than re-deriving the same "active AND not expired" logic a second
    // time in application code.
    pool.query<{
      id: number;
      property_id: string;
      reason_code: string;
      flagged_by_user_id: string;
      flagged_at: string;
      incident_report: string | null;
      review_by: string | null;
    }>(
      `SELECT id, property_id, reason_code, flagged_by_user_id, flagged_at, incident_report, review_by
       FROM property_exclusions_effective WHERE property_id = ANY($1::bigint[])`,
      [propertyIds],
    ),
  ]);

  const unitIds = unitsResult.rows.map((r) => r.id);
  const [leasesResult, askingRentsResult] = await Promise.all([
    unitIds.length
      ? pool.query<{
          id: number;
          unit_id: string;
          lease_status: "Active" | "Future";
          lease_from: string;
          lease_to: string | null;
          current_rent: string | null;
        }>(
          `SELECT id, unit_id, lease_status, lease_from, lease_to, current_rent
           FROM leases WHERE unit_id = ANY($1::bigint[]) AND lease_status IN ('Active','Future')
           ORDER BY unit_id, (lease_status = 'Active') DESC, lease_from ASC`,
          [unitIds],
        )
      : Promise.resolve({ rows: [] as never[] }),
    unitIds.length
      ? pool.query<{ id: number; unit_id: string | null; asking_rent: string; listed_at: string | null }>(
          `SELECT id, unit_id, asking_rent, listed_at
           FROM vacant_unit_asking_rents WHERE unit_id = ANY($1::bigint[])
           ORDER BY unit_id, listed_at DESC NULLS LAST`,
          [unitIds],
        )
      : Promise.resolve({ rows: [] as never[] }),
  ]);

  // "Current" lease per unit = the first Active row, or else the earliest
  // Future row — the ORDER BY above already sorts Active-first then by
  // start date, so the first row per unit_id is the one to show (schema.md:
  // "'Current' is a query, not a column").
  const currentLeaseByUnit = new Map<number, (typeof leasesResult.rows)[number]>();
  for (const lease of leasesResult.rows as Array<{
    id: number;
    unit_id: string;
    lease_status: "Active" | "Future";
    lease_from: string;
    lease_to: string | null;
    current_rent: string | null;
  }>) {
    const unitId = Number(lease.unit_id);
    if (!currentLeaseByUnit.has(unitId)) currentLeaseByUnit.set(unitId, lease);
  }

  // Stores the vacant_unit_asking_rents row's OWN id (not just the rent
  // figure) — needed below to look up that listing's recurring charges,
  // which key off this id (see migration 0018 in projects/map).
  const askingRentByUnit = new Map<number, { id: number; askingRent: string }>();
  for (const row of askingRentsResult.rows as Array<{
    id: number;
    unit_id: string | null;
    asking_rent: string;
    listed_at: string | null;
  }>) {
    if (row.unit_id !== null) {
      const unitId = Number(row.unit_id);
      if (!askingRentByUnit.has(unitId)) askingRentByUnit.set(unitId, { id: row.id, askingRent: row.asking_rent });
    }
  }

  const leaseIds = [...currentLeaseByUnit.values()].map((l) => l.id);
  const askingRentIds = [...askingRentByUnit.values()].map((a) => a.id);
  const [tenantsResult, leaseChargesResult, vacantChargesResult] = await Promise.all([
    leaseIds.length
      ? pool.query<{ lease_id: string; full_name: string; phone: string | null; is_primary: boolean }>(
          `SELECT lease_id, full_name, phone, is_primary
           FROM lease_tenants WHERE lease_id = ANY($1::bigint[])
           ORDER BY lease_id, is_primary DESC, full_name`,
          [leaseIds],
        )
      : Promise.resolve({ rows: [] as Array<{ lease_id: string; full_name: string; phone: string | null; is_primary: boolean }> }),
    // Recurring charges beyond base rent, leased side (synced from
    // Buildium's /leases/{id}/recurringtransactions — see projects/map's
    // src/buildium/sync.ts). excluded_from_display filters out charges like
    // "Resident Benefits Package" that Jason doesn't want on the popup
    // (src/lib/feeClassification.ts in projects/map is the single source of
    // truth for that classification, applied at sync time).
    leaseIds.length
      ? pool.query<{ lease_id: string; label: string; amount: string }>(
          `SELECT lease_id, label, amount
           FROM lease_recurring_charges
           WHERE lease_id = ANY($1::bigint[]) AND NOT excluded_from_display
           ORDER BY lease_id, label`,
          [leaseIds],
        )
      : Promise.resolve({ rows: [] as Array<{ lease_id: string; label: string; amount: string }> }),
    // Same idea, vacant-listing side (synced from RentEngine's monthly_fees
    // — see projects/map's src/rentengine/sync.ts).
    askingRentIds.length
      ? pool.query<{ vacant_unit_asking_rent_id: string; label: string; amount: string }>(
          `SELECT vacant_unit_asking_rent_id, label, amount
           FROM vacant_listing_recurring_charges
           WHERE vacant_unit_asking_rent_id = ANY($1::bigint[]) AND NOT excluded_from_display
           ORDER BY vacant_unit_asking_rent_id, label`,
          [askingRentIds],
        )
      : Promise.resolve({ rows: [] as Array<{ vacant_unit_asking_rent_id: string; label: string; amount: string }> }),
  ]);

  const tenantsByLease = new Map<number, MapTenant[]>();
  for (const t of tenantsResult.rows) {
    const leaseId = Number(t.lease_id);
    const arr = tenantsByLease.get(leaseId) ?? [];
    arr.push({ fullName: t.full_name, phone: t.phone, isPrimary: t.is_primary });
    tenantsByLease.set(leaseId, arr);
  }

  const chargesByLease = new Map<number, MapRecurringCharge[]>();
  for (const c of leaseChargesResult.rows) {
    const leaseId = Number(c.lease_id);
    const arr = chargesByLease.get(leaseId) ?? [];
    arr.push({ label: c.label, amount: c.amount });
    chargesByLease.set(leaseId, arr);
  }

  const chargesByAskingRentId = new Map<number, MapRecurringCharge[]>();
  for (const c of vacantChargesResult.rows) {
    const askingRentId = Number(c.vacant_unit_asking_rent_id);
    const arr = chargesByAskingRentId.get(askingRentId) ?? [];
    arr.push({ label: c.label, amount: c.amount });
    chargesByAskingRentId.set(askingRentId, arr);
  }

  const unitsByProperty = new Map<number, MapUnit[]>();
  for (const u of unitsResult.rows) {
    const lease = currentLeaseByUnit.get(u.id);
    const askingRentRow = askingRentByUnit.get(u.id) ?? null;
    const propertyId = Number(u.property_id);
    const arr = unitsByProperty.get(propertyId) ?? [];
    arr.push({
      id: u.id,
      unitLabel: u.unit_label,
      bedrooms: u.bedrooms,
      bathrooms: u.bathrooms,
      squareFeet: u.square_feet,
      leaseStatus: lease?.lease_status ?? null,
      leaseFrom: lease?.lease_from ?? null,
      leaseTo: lease?.lease_to ?? null,
      currentRent: lease?.current_rent ?? null,
      askingRent: !lease ? (askingRentRow?.askingRent ?? null) : null,
      isVacant: !lease,
      tenants: lease ? (tenantsByLease.get(lease.id) ?? []) : [],
      recurringCharges: lease
        ? (chargesByLease.get(lease.id) ?? [])
        : askingRentRow
          ? (chargesByAskingRentId.get(askingRentRow.id) ?? [])
          : [],
    });
    unitsByProperty.set(propertyId, arr);
  }

  // Photos: batch-sign every primary photo path in one call.
  const photoPaths = photosResult.rows.map((p) => p.storage_path);
  const signedUrls = photoPaths.length
    ? await getSignedPhotoUrls(photosResult.rows[0]!.storage_bucket, photoPaths)
    : new Map<string, string>();
  const photoByProperty = new Map<number, string>();
  for (const p of photosResult.rows) {
    const url = signedUrls.get(p.storage_path);
    if (url) photoByProperty.set(Number(p.property_id), url);
  }

  // Exclusions: resolve "who flagged it" against LimeHQ's own users table.
  const flaggerIds = exclusionsResult.rows.map((e) => e.flagged_by_user_id);
  const displayNames = await resolveDisplayNames(flaggerIds);
  const exclusionByProperty = new Map<number, MapExclusion>();
  for (const e of exclusionsResult.rows) {
    exclusionByProperty.set(Number(e.property_id), {
      id: e.id,
      reasonCode: e.reason_code,
      flaggedByName: displayNames.get(Number(e.flagged_by_user_id)) ?? "Unknown",
      flaggedAt: e.flagged_at,
      incidentReport: e.incident_report,
      reviewBy: e.review_by,
    });
  }

  return propertiesResult.rows.map((p) => ({
    id: p.id,
    addressLine1: p.address_line1,
    addressLine2: p.address_line2,
    city: p.city,
    state: p.state,
    postalCode: p.postal_code,
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
    photoUrl: photoByProperty.get(p.id) ?? null,
    units: unitsByProperty.get(p.id) ?? [],
    exclusion: exclusionByProperty.get(p.id) ?? null,
  }));
}

// ------------------------------------------------------------------ //
// Exclusion flag create/remove                                        //
// ------------------------------------------------------------------ //

export const REASON_CODES_NO_EVIDENCE = [
  "structure_condition",
  "never_renovated",
  "too_far_to_service",
  "past_operational_problems",
] as const;
export const REASON_CODE_SAFETY = "staff_safety_concern" as const;

export async function createExclusion(
  pool: Pool,
  args: {
    propertyId: number;
    reasonCode: string;
    incidentReport: string | null;
    reviewBy: string | null;
    flaggedByUserId: number;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO property_exclusions
       (property_id, reason_code, incident_report, review_by, flagged_by_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [args.propertyId, args.reasonCode, args.incidentReport, args.reviewBy, args.flaggedByUserId],
  );
}

export async function removeExclusion(
  pool: Pool,
  exclusionId: number,
  removedByUserId: number,
): Promise<void> {
  await pool.query(
    `UPDATE property_exclusions
     SET active = false, removed_by_user_id = $2, removed_at = now(), updated_at = now()
     WHERE id = $1 AND active = true`,
    [exclusionId, removedByUserId],
  );
}

// ------------------------------------------------------------------ //
// Named-area exclusion tool                                           //
// ------------------------------------------------------------------ //

export interface NamedArea {
  id: number;
  areaName: string;
  boundary: LatLng[];
  status: "shadow" | "active" | "retired";
  createdByName: string;
  createdAt: string;
  activatedByName: string | null;
  activatedAt: string | null;
  retiredByName: string | null;
  retiredAt: string | null;
}

export async function listNamedAreas(pool: Pool): Promise<NamedArea[]> {
  const result = await pool.query<{
    id: number;
    area_name: string;
    boundary: unknown;
    status: "shadow" | "active" | "retired";
    // bigint FKs — see the NOTE in fetchActiveMapProperties above; pg
    // returns these as strings, not numbers.
    created_by_user_id: string;
    created_at: string;
    activated_by_user_id: string | null;
    activated_at: string | null;
    retired_by_user_id: string | null;
    retired_at: string | null;
  }>(
    `SELECT id, area_name, boundary, status, created_by_user_id, created_at,
            activated_by_user_id, activated_at, retired_by_user_id, retired_at
     FROM named_area_exclusions ORDER BY created_at DESC`,
  );

  const userIds = result.rows.flatMap((r) => [
    r.created_by_user_id,
    r.activated_by_user_id,
    r.retired_by_user_id,
  ]);
  const names = await resolveDisplayNames(userIds);

  return result.rows.map((r) => ({
    id: r.id,
    areaName: r.area_name,
    boundary: validateBoundary(r.boundary),
    status: r.status,
    createdByName: names.get(Number(r.created_by_user_id)) ?? "Unknown",
    createdAt: r.created_at,
    activatedByName: r.activated_by_user_id ? (names.get(Number(r.activated_by_user_id)) ?? "Unknown") : null,
    activatedAt: r.activated_at,
    retiredByName: r.retired_by_user_id ? (names.get(Number(r.retired_by_user_id)) ?? "Unknown") : null,
    retiredAt: r.retired_at,
  }));
}

export async function getNamedArea(pool: Pool, id: number): Promise<NamedArea | null> {
  const areas = await listNamedAreas(pool);
  return areas.find((a) => a.id === id) ?? null;
}

export async function createNamedArea(
  pool: Pool,
  args: { areaName: string; boundary: LatLng[]; createdByUserId: number },
): Promise<number> {
  const validated = validateBoundary(args.boundary);
  const result = await pool.query<{ id: number }>(
    `INSERT INTO named_area_exclusions (area_name, boundary, created_by_user_id)
     VALUES ($1, $2::jsonb, $3) RETURNING id`,
    [args.areaName, JSON.stringify(validated), args.createdByUserId],
  );
  return result.rows[0]!.id;
}

/** Live "what would this boundary match right now" preview — geometric
 * only, per computeAreaMatches.ts's own documentation in the canonical Map
 * project: this does NOT mean these properties are excluded from
 * anything real. Only a `status = 'active'` area has any real effect, and
 * nothing in this file (or anywhere else in this module) treats a shadow
 * match as a live exclusion. */
export async function computeLiveAreaMatches(
  pool: Pool,
  boundary: LatLng[],
): Promise<Array<{ id: number; addressLine1: string; city: string }>> {
  const properties = await pool.query<{
    id: number;
    address_line1: string;
    city: string;
    latitude: string | null;
    longitude: string | null;
  }>(`SELECT id, address_line1, city, latitude, longitude FROM properties WHERE geocode_status = 'ok'`);

  const matches: Array<{ id: number; addressLine1: string; city: string }> = [];
  for (const p of properties.rows) {
    if (p.latitude === null || p.longitude === null) continue;
    const point = { lat: Number(p.latitude), lng: Number(p.longitude) };
    if (isPointInPolygon(point, boundary)) {
      matches.push({ id: p.id, addressLine1: p.address_line1, city: p.city });
    }
  }
  return matches;
}

export interface ShadowLogSummary {
  distinctPropertiesEverMatched: number;
  distinctSnapshotDays: number;
  firstSnapshotAt: string | null;
  lastSnapshotAt: string | null;
}

export async function fetchShadowLogSummary(pool: Pool, areaId: number): Promise<ShadowLogSummary> {
  const result = await pool.query<{
    distinct_properties: string;
    distinct_days: string;
    first_at: string | null;
    last_at: string | null;
  }>(
    `SELECT
       count(DISTINCT property_id) AS distinct_properties,
       count(DISTINCT matched_at::date) AS distinct_days,
       min(matched_at) AS first_at,
       max(matched_at) AS last_at
     FROM named_area_exclusion_shadow_matches
     WHERE named_area_exclusion_id = $1`,
    [areaId],
  );
  const row = result.rows[0];
  return {
    distinctPropertiesEverMatched: Number(row?.distinct_properties ?? 0),
    distinctSnapshotDays: Number(row?.distinct_days ?? 0),
    firstSnapshotAt: row?.first_at ?? null,
    lastSnapshotAt: row?.last_at ?? null,
  };
}

export async function activateNamedArea(pool: Pool, areaId: number, userId: number): Promise<void> {
  await pool.query(
    `UPDATE named_area_exclusions
     SET status = 'active', activated_by_user_id = $2, activated_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'shadow'`,
    [areaId, userId],
  );
}

export async function retireNamedArea(pool: Pool, areaId: number, userId: number): Promise<void> {
  await pool.query(
    `UPDATE named_area_exclusions
     SET status = 'retired', retired_by_user_id = $2, retired_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'active'`,
    [areaId, userId],
  );
}
