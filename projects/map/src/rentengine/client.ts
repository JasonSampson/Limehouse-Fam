// RentEngine API client — STUB.
//
// Oracle's spec (Section 2) and Neo's schema.md are both explicit: Jason
// has (or can self-create) a RentEngine API key, but as of this build pass
// it has not been handed to this project, and none of the following are
// confirmed:
//   - Auth method (API key header? bearer token? query param?)
//   - Base URL / endpoint paths for vacant listings
//   - The matching key between a RentEngine listing and a Buildium unit
//     (address match? a shared ID RentEngine already knows about?)
//
// DO NOT guess at these — building against an unconfirmed shape here would
// produce code that looks done but silently does nothing useful, which is
// worse than an honest stub. Q/Neo should revisit this file together once
// Jason hands over real API access and docs (see also
// vacant_unit_asking_rents in migrations/0005, and src/rentengine/sync.ts
// for how this stub surfaces in sync_runs without either crashing the
// whole daily sync or pretending to be a working integration).
export class RentEngineNotConfiguredError extends Error {
  constructor() {
    super(
      "RentEngine API credentials/endpoint are not configured (RENTENGINE_API_KEY / RENTENGINE_BASE_URL). " +
        "This is a known, documented gap — see src/rentengine/client.ts."
    );
    this.name = "RentEngineNotConfiguredError";
  }
}

export interface RentEngineListing {
  listingId: string;
  askingRent: number;
  listedAt: string | null;
  // Matching key: UNCONFIRMED. Left as an opaque string the caller must
  // resolve against Buildium units once the real matching key is known.
  matchingKeyRaw: string;
}

// Not implemented — always throws RentEngineNotConfiguredError until this
// file is revisited with real credentials/docs in hand.
export async function fetchVacantListings(): Promise<RentEngineListing[]> {
  throw new RentEngineNotConfiguredError();
}
