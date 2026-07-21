import type { Pool } from "pg";
import { geocodeAddress } from "./googleGeocoder.js";
import { logInfo } from "../lib/appLogger.js";

export interface GeocodeSyncResult {
  attempted: number;
  succeeded: number;
  errors: string[];
}

// Geocodes any property still missing coordinates (geocode_status =
// 'pending', or a prior 'failed' attempt worth retrying). Runs after
// buildium_sync so newly-synced properties have an address to geocode.
// Per-property failures are collected as item errors (surfaced via
// sync_runs.error_message + an alert, per mapJobRunner.ts) rather than
// aborting the whole run — one bad address shouldn't block every other
// property's geocode.
export async function geocodeNewProperties(jobPool: Pool): Promise<GeocodeSyncResult> {
  const rows = await jobPool.query<{
    id: number;
    address_line1: string;
    address_line2: string | null;
    city: string;
    state: string;
    postal_code: string;
  }>(
    `SELECT id, address_line1, address_line2, city, state, postal_code
     FROM properties
     WHERE geocode_status IN ('pending', 'failed')`
  );

  const errors: string[] = [];
  let succeeded = 0;

  for (const row of rows.rows) {
    const addressParts = [row.address_line1, row.address_line2, row.city, row.state, row.postal_code].filter(
      Boolean
    );
    const address = addressParts.join(", ");

    try {
      const result = await geocodeAddress(address);
      if (!result) {
        await jobPool.query(
          `UPDATE properties SET geocode_status = 'failed', geocoded_at = now() WHERE id = $1`,
          [row.id]
        );
        errors.push(`Property ${row.id}: Google Geocoding API returned no result for its address on file`);
        continue;
      }
      await jobPool.query(
        `UPDATE properties
           SET latitude = $1, longitude = $2, geocode_status = 'ok', geocoded_at = now()
         WHERE id = $3`,
        [result.latitude, result.longitude, row.id]
      );
      succeeded += 1;
    } catch (err) {
      await jobPool.query(`UPDATE properties SET geocode_status = 'failed', geocoded_at = now() WHERE id = $1`, [
        row.id,
      ]);
      errors.push(
        `Property ${row.id}: geocoding failed — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  logInfo("geocode sync complete", { attempted: rows.rows.length, succeeded, errorCount: errors.length });
  return { attempted: rows.rows.length, succeeded, errors };
}
