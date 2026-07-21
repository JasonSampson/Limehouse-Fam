import type { Pool } from "pg";
import { computeAreaMatches } from "./computeAreaMatches.js";
import { logInfo } from "../lib/appLogger.js";

export interface ShadowSnapshotResult {
  areasSnapshotted: number;
  matchesRecorded: number;
  errors: string[];
}

// Asimov's governance-review.md condition 3: before a named area can move
// from shadow to active, Mason (and ideally Jason's attorney) needs to
// review "the actual shadow-mode exclusion log against Hampton Roads
// demographic/historical redlining data — not just confirming the log
// works, confirming what it shows." A live "what matches right now" query
// only shows one instant; this function is what actually builds that log
// over time — one snapshot row per (area, property) match, once per run,
// for every area still in `shadow` status. Areas that are `active` or
// `retired` are intentionally excluded here — this table exists to
// support the shadow-mode review, not to be a permanent audit trail for
// what an active area is currently doing (that's a different, future
// concern for whoever builds the actual "is this property excluded"
// consumer).
export async function snapshotShadowAreaMatches(jobPool: Pool): Promise<ShadowSnapshotResult> {
  const shadowAreas = await jobPool.query<{ id: number; area_name: string }>(
    `SELECT id, area_name FROM named_area_exclusions WHERE status = 'shadow'`
  );

  let matchesRecorded = 0;
  const errors: string[] = [];

  for (const area of shadowAreas.rows) {
    try {
      const matchedPropertyIds = await computeAreaMatches(jobPool, area.id);
      for (const propertyId of matchedPropertyIds) {
        await jobPool.query(
          `INSERT INTO named_area_exclusion_shadow_matches (named_area_exclusion_id, property_id, matched_at)
           VALUES ($1, $2, now())`,
          [area.id, propertyId]
        );
      }
      matchesRecorded += matchedPropertyIds.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Area "${area.area_name}" (id=${area.id}): ${message}`);
    }
  }

  logInfo("named-area shadow snapshot complete", {
    areasSnapshotted: shadowAreas.rows.length,
    matchesRecorded,
    errorCount: errors.length,
  });

  return { areasSnapshotted: shadowAreas.rows.length, matchesRecorded, errors };
}
