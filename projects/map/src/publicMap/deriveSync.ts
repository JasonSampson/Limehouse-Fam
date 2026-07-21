import type { Pool } from "pg";
import { computeJitteredCoordinates } from "../config/publicMapJitter.js";
import { loadEnv } from "../config/env.js";
import { logInfo } from "../lib/appLogger.js";

const ALLOWED_CITIES = new Set(["Virginia Beach", "Norfolk", "Chesapeake", "Portsmouth", "Suffolk"]);

export interface PublicMapDeriveResult {
  locationsCreated: number;
  locationsConfirmed: number;
}

// Populates map_public.locations. Additive-only, per Neo's schema.md and
// spec Risk #3:
//   - NEVER deletes a row.
//   - NEVER touches a row based on properties.is_active or
//     property_exclusions — this function does not join against
//     property_exclusions for any purpose, full stop.
//   - Coordinates are computed ONCE, at first insertion, from a
//     deterministic hash of the property's own id (computeJitteredCoordinates).
//     On every later sync, an already-published dot's city/lat/lng/label
//     are left untouched — only last_confirmed_at advances. This guarantees
//     a dot never visibly moves, even if the property's true geocode is
//     later corrected.
export async function derivePublicMapLocations(jobPool: Pool): Promise<PublicMapDeriveResult> {
  const env = loadEnv();

  // Every property ever managed, active or not (spec: "every property
  // Limehouse has ever managed"), restricted to the 5 cities, that has a
  // successful geocode to jitter from. geocode_status = 'ok' is required
  // simply because there's no true location yet to offset from otherwise —
  // a property still pending/failed geocoding is picked up on a later run
  // once geocode_sync succeeds for it.
  const candidates = await jobPool.query<{
    id: number;
    city: string;
    latitude: string;
    longitude: string;
  }>(
    `SELECT id, city, latitude, longitude
     FROM properties
     WHERE geocode_status = 'ok'
       AND city = ANY($1::text[])`,
    [Array.from(ALLOWED_CITIES)]
  );

  let locationsCreated = 0;
  let locationsConfirmed = 0;

  for (const property of candidates.rows) {
    const trueLatitude = Number(property.latitude);
    const trueLongitude = Number(property.longitude);
    const { latitude, longitude } = computeJitteredCoordinates(
      property.id,
      trueLatitude,
      trueLongitude,
      env.PUBLIC_MAP_JITTER_RADIUS_METERS
    );

    const result = await jobPool.query<{ inserted: boolean }>(
      // Schema-qualified: map_public is a different schema than map, so
      // this table is NOT reached via map_sync_job's search_path=map
      // setting the way properties/units/etc. are — it must always be
      // referenced explicitly.
      `INSERT INTO map_public.locations (
         city, latitude, longitude, source_property_id, first_appeared_at, last_confirmed_at
       ) VALUES ($1,$2,$3,$4,now(),now())
       ON CONFLICT (source_property_id) DO UPDATE SET
         last_confirmed_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [property.city, latitude, longitude, property.id]
    );
    if (result.rows[0]?.inserted) {
      locationsCreated += 1;
    } else {
      locationsConfirmed += 1;
    }
  }

  logInfo("public map derive complete", { locationsCreated, locationsConfirmed });
  return { locationsCreated, locationsConfirmed };
}
