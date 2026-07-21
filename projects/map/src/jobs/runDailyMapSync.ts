import type { Pool } from "pg";
import { runTrackedSyncStep } from "./mapJobRunner.js";
import { syncBuildiumData } from "../buildium/sync.js";
import { geocodeNewProperties } from "../geocode/geocodeSync.js";
import { syncPropertyPhotos } from "../photos/photoSync.js";
import { syncVacantUnitAskingRents } from "../rentengine/sync.js";
import { derivePublicMapLocations } from "../publicMap/deriveSync.js";
import { snapshotShadowAreaMatches } from "../namedAreaExclusions/shadowSnapshot.js";
import { logError } from "../lib/appLogger.js";

// Orchestrates the full daily sync as five independently-tracked steps
// (one sync_runs row each, matching schema.md's job_name enum:
// buildium_sync, geocode_sync, photo_sync, rentengine_sync,
// public_map_derive). Steps run in dependency order (geocode needs
// properties synced first; photo/derive need properties to exist; derive
// also wants geocoded coordinates) but a HARD failure in one step (the
// whole step function throwing, not just a per-item error) is caught here
// so it doesn't take down the rest of the day's sync — e.g. a Buildium
// outage during photo_sync shouldn't prevent public_map_derive from still
// confirming already-published dots.
export async function runDailyMapSync(jobPool: Pool, scheduledFor: Date): Promise<void> {
  const steps: Array<[string, () => Promise<unknown>]> = [
    [
      "buildium_sync",
      () =>
        runTrackedSyncStep(jobPool, "buildium_sync", scheduledFor, async () => {
          const r = await syncBuildiumData(jobPool);
          return {
            counts: { properties_synced: r.propertiesSynced, units_synced: r.unitsSynced, leases_synced: r.leasesSynced },
            errors: r.errors,
          };
        }),
    ],
    [
      "geocode_sync",
      () =>
        runTrackedSyncStep(jobPool, "geocode_sync", scheduledFor, async () => {
          const r = await geocodeNewProperties(jobPool);
          return { counts: { properties_synced: r.succeeded }, errors: r.errors };
        }),
    ],
    [
      "photo_sync",
      () =>
        runTrackedSyncStep(jobPool, "photo_sync", scheduledFor, async () => {
          const r = await syncPropertyPhotos(jobPool);
          return { counts: { photos_synced: r.photosSynced }, errors: r.errors };
        }),
    ],
    [
      "rentengine_sync",
      () =>
        runTrackedSyncStep(jobPool, "rentengine_sync", scheduledFor, async () => {
          const outcome = await syncVacantUnitAskingRents(jobPool);
          // Not configured is a known, documented gap — record it visibly
          // (error_message populated, queryable in sync_runs) without
          // paging Jason about something he already knows isn't built yet.
          // Once configured=true, any real failure alerts like any other
          // step (alertOnErrors defaults true, unset here).
          return outcome.configured
            ? { counts: {}, errors: [] }
            : { counts: {}, errors: [outcome.note], alertOnErrors: false };
        }),
    ],
    [
      "public_map_derive",
      () =>
        runTrackedSyncStep(jobPool, "public_map_derive", scheduledFor, async () => {
          const r = await derivePublicMapLocations(jobPool);
          return { counts: { public_locations_synced: r.locationsCreated } };
        }),
    ],
    [
      // Builds the dated log Asimov's governance-review.md requires Mason
      // (and ideally Jason's attorney) to review before any named area can
      // move from shadow to active — see shadowSnapshot.ts. Does nothing
      // to any area that isn't currently in `shadow` status, and never
      // makes any area's matches count as a real exclusion.
      "named_area_shadow_snapshot",
      () =>
        runTrackedSyncStep(jobPool, "named_area_shadow_snapshot", scheduledFor, async () => {
          const r = await snapshotShadowAreaMatches(jobPool);
          return { counts: {}, errors: r.errors };
        }),
    ],
  ];

  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      // runTrackedSyncStep already wrote the failed sync_runs row and sent
      // the alert — just log and move on to the next step.
      logError(`daily map sync: step "${name}" failed, continuing to next step`, {
        jobName: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
