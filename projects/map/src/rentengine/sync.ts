import type { Pool } from "pg";
import { loadEnv } from "../config/env.js";
import { fetchVacantListings, RentEngineNotConfiguredError } from "./client.js";
import { logInfo, logWarn } from "../lib/appLogger.js";

export interface RentEngineSyncOutcome {
  configured: boolean;
  listingsSynced: number;
  note: string;
}

// Documented stub, not a silent no-op: this always writes something
// visible about its own state (returned to the caller, which records it in
// sync_runs — see runDailyMapSync.ts). If RentEngine credentials aren't
// set, this is an EXPECTED, known gap (not paged to Jason as a failure —
// he already knows RentEngine isn't wired up yet); if credentials ARE set
// but the call still fails, that IS a real failure and should alert, same
// as any other sync step.
export async function syncVacantUnitAskingRents(_jobPool: Pool): Promise<RentEngineSyncOutcome> {
  const env = loadEnv();

  if (!env.RENTENGINE_API_KEY || !env.RENTENGINE_BASE_URL) {
    const note =
      "RentEngine sync skipped: RENTENGINE_API_KEY / RENTENGINE_BASE_URL not configured. " +
      "This is a documented, expected gap (see src/rentengine/client.ts) — Jason has not yet " +
      "handed over RentEngine API access/docs for this project. No vacant-unit asking rent data " +
      "was synced this run; the map will fall back to showing no asking-rent figure for vacant units.";
    logWarn("rentengine sync: not configured, stub ran as documented", {});
    return { configured: false, listingsSynced: 0, note };
  }

  // Credentials ARE present — attempt the real call. This currently always
  // throws (client.ts is unimplemented) until Q/Neo build the real
  // integration against confirmed RentEngine docs; that failure SHOULD
  // alert, since at that point Jason has supplied credentials and expects
  // this to work.
  try {
    const listings = await fetchVacantListings();
    // Matching against Buildium units is intentionally not implemented —
    // the matching key is unconfirmed (client.ts). Once fetchVacantListings
    // returns real data, this is where Q/Neo add the unit-matching + upsert
    // into vacant_unit_asking_rents.
    logInfo("rentengine sync: fetched listings but matching/upsert is not yet implemented", {});
    return {
      configured: true,
      listingsSynced: 0,
      note: `Fetched ${listings.length} listing(s) but unit-matching logic is not yet implemented.`,
    };
  } catch (err) {
    if (err instanceof RentEngineNotConfiguredError) {
      return { configured: false, listingsSynced: 0, note: err.message };
    }
    throw err;
  }
}
