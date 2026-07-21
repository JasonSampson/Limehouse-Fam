import type { Pool } from "pg";
import { isPointInPolygon, validateBoundary, type LatLng } from "./pointInPolygon.js";

export interface NamedAreaExclusion {
  id: number;
  areaName: string;
  boundary: LatLng[];
  status: "shadow" | "active" | "retired";
}

async function fetchArea(pool: Pool, areaId: number): Promise<NamedAreaExclusion> {
  const result = await pool.query<{
    id: number;
    area_name: string;
    boundary: unknown;
    status: "shadow" | "active" | "retired";
  }>(`SELECT id, area_name, boundary, status FROM named_area_exclusions WHERE id = $1`, [areaId]);

  const row = result.rows[0];
  if (!row) throw new Error(`No named_area_exclusions row with id ${areaId}.`);

  return {
    id: row.id,
    areaName: row.area_name,
    boundary: validateBoundary(row.boundary),
    status: row.status,
  };
}

// Every currently-active-or-shadow property, geocoded, checked against a
// single area's boundary. This is the "what would this area exclude"
// computation — used both by the periodic shadow-mode snapshot (below)
// and by whatever review UI Tron builds for a staff member to preview an
// area before deciding whether to activate it.
//
// IMPORTANT — this function does NOT filter by area status. Returning
// matches for a `shadow` area is exactly the point (that's the whole
// review mechanism); it does NOT mean those properties are excluded from
// anything real. The one and only place that distinction must be
// enforced is in whatever future code treats a match as a real business
// exclusion — that code must filter on `status = 'active'` itself. This
// function's job is purely geometric ("does this property fall inside
// this boundary"), not business-rule enforcement.
export async function computeAreaMatches(pool: Pool, areaId: number): Promise<number[]> {
  const area = await fetchArea(pool, areaId);

  const properties = await pool.query<{ id: number; latitude: string | null; longitude: string | null }>(
    `SELECT id, latitude, longitude FROM properties WHERE geocode_status = 'ok'`
  );

  const matchedPropertyIds: number[] = [];
  for (const property of properties.rows) {
    if (property.latitude === null || property.longitude === null) continue;
    const point = { lat: Number(property.latitude), lng: Number(property.longitude) };
    if (isPointInPolygon(point, area.boundary)) {
      matchedPropertyIds.push(property.id);
    }
  }
  return matchedPropertyIds;
}
