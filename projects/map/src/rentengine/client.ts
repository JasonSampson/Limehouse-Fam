import { z } from "zod";
import { loadEnv } from "../config/env.js";

export class RentEngineNotConfiguredError extends Error {
  constructor() {
    super(
      "RentEngine API credentials/endpoint are not configured (RENTENGINE_API_KEY / RENTENGINE_BASE_URL). " +
        "This is a known, documented gap — see src/rentengine/sync.ts."
    );
    this.name = "RentEngineNotConfiguredError";
  }
}

// CONFIRMED LIVE 2026-07-21 against Jason's real RentEngine account (same
// account already integrated in projects/limehouse-dashboard — base URL,
// Bearer auth, and the fact that /units returns a bare JSON array with no
// pagination needed are all reused/confirmed from there per docs/schema.md's
// Buildium/RentEngine Field Gaps #3, not re-derived). The address
// sub-object's structured fields (street_number, street_name, unit, city,
// zip_code) were fetched fresh for THIS project and are richer than what
// Dashboard's client.ts parses (it only reads formatted_address) — using
// them directly here means addressMatch.ts doesn't need to regex-parse a
// single string apart; formatted_address is kept only as a fallback/label.
const rentEngineAddressSchema = z
  .object({
    street_number: z.string().nullable().optional(),
    street_name: z.string().nullable().optional(),
    unit: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    zip_code: z.string().nullable().optional(),
    formatted_address: z.string().nullable().optional(),
  })
  .nullable();

// status kept as a plain string (not z.enum) — real confirmed values
// include Leased, Available, and (per Dashboard's client.ts research on
// this same account) On Hold / Incomplete. A future unrecognized value
// must not crash the whole /units fetch, same defensive pattern used
// throughout Dashboard's client.ts.
//
// CONFIRMED LIVE (2026-07-21, all 15 real on-market listings): monthly_fees
// is a real structured field — [{name, type, amount}], no per-fee id.
// CORRECTED same day, per a real production failure: the original research
// pass only inspected on-market (Available/On Hold) listings and concluded
// this array always holds exactly one entry ("Resident Benefits Package").
// That was true for on-market listings, but wrong as a claim about the full
// /units response — LEASED units (status "Leased", excluded from the final
// on-market output by isOnMarketStatus below, but NOT excluded from the zod
// parse that runs on the full raw response first) really do carry a SECOND
// monthly_fees entry for utilities/solar (confirmed: "Water/sewer/trash"
// $75, "Water/Sewer/Trash" $75, "Solar Rent" $100 — real listings 41121,
// 41122, 41123, 63211). Real production regression confirmed live: that
// second entry's `amount` comes back as a STRING ("75", "75.00", "100")
// while the first entry's amount is a real number (45.95) — inconsistent
// typing within the same array, same real-data messiness as Buildium's
// Memo wording drift. z.coerce.number() handles both shapes; a plain
// z.number() crashed the whole array's parse over data that wasn't even
// going to be used (a Leased unit is filtered out below regardless).
// type is kept as a plain string (only "dollar" observed live) rather than
// a fixed enum, same defensive posture as status.
const rentEngineMonthlyFeeSchema = z.object({
  name: z.string(),
  type: z.string(),
  amount: z.coerce.number(),
});

const rentEngineUnitSchema = z.object({
  id: z.number(),
  status: z.string(),
  target_rental_rate: z.number().nullable(),
  address: rentEngineAddressSchema,
  monthly_fees: z.array(rentEngineMonthlyFeeSchema).nullable().optional(),
});

export interface RentEngineListingAddress {
  streetNumber: string | null;
  streetName: string | null;
  unit: string | null;
  city: string | null;
  formattedAddress: string | null;
}

export interface RentEngineMonthlyFee {
  label: string;
  amount: number;
}

export interface RentEngineListing {
  id: number;
  status: string;
  askingRent: number | null;
  address: RentEngineListingAddress | null;
  monthlyFees: RentEngineMonthlyFee[];
}

// Real statuses confirmed live for this account: Leased and Available seen
// in a real 70-record pull (2026-07-21); On Hold and Incomplete are real
// values too per Dashboard's client.ts research on this same account, just
// not present in that particular pull. Only Available/On Hold count as
// "on market" — same rule Dashboard's isUnitOnMarket already established
// for this exact account, reused here rather than re-derived. Everything
// else (Leased, Incomplete, a future unrecognized value) is excluded from
// a table that's specifically about CURRENT asking rent for vacant units.
export function isOnMarketStatus(status: string): boolean {
  return status === "Available" || status === "On Hold";
}

export interface RentEngineFetchResult {
  listings: RentEngineListing[];
  // One entry per raw /units record that failed to parse. A single bad
  // record (real example: a Leased unit — already excluded from the
  // output by isOnMarketStatus — with a malformed monthly_fees entry) must
  // not take down every other listing's data. CONFIRMED LIVE REGRESSION
  // (2026-07-21): the previous version ran `z.array(schema).parse(json)`
  // as one all-or-nothing operation over the full raw response, so one bad
  // record anywhere in the ~70-unit account crashed the entire sync step —
  // including over data for units that were never going into the output in
  // the first place. Parsing is now per-record (see below), same
  // "isolate and log the one bad item, keep the rest" shape already used
  // for address-matching failures in sync.ts.
  errors: string[];
}

// Parses the raw /units response defensively, one record at a time. Exported
// for testing — takes the already-fetched JSON body directly so a real
// malformed-data shape can be exercised without a live network call.
export function parseRentEngineUnitsResponse(json: unknown): RentEngineFetchResult {
  // The root shape itself not being an array is a genuinely different kind
  // of failure (the whole account/endpoint is broken, not "one listing has
  // bad data") — that's still worth a hard throw rather than silently
  // returning nothing.
  const rawUnits = z.array(z.unknown()).parse(json);

  const listings: RentEngineListing[] = [];
  const errors: string[] = [];

  for (let i = 0; i < rawUnits.length; i++) {
    const raw = rawUnits[i];
    const result = rentEngineUnitSchema.safeParse(raw);
    if (!result.success) {
      // Best-effort id/address for a human-readable error even though the
      // record failed validation — these fields may themselves be present
      // and fine even when some other field (e.g. monthly_fees[1].amount)
      // is what actually failed.
      const rawObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const idHint = typeof rawObj.id === "number" ? rawObj.id : "unknown id";
      const addressHint =
        rawObj.address && typeof rawObj.address === "object"
          ? ((rawObj.address as Record<string, unknown>).formatted_address ?? "unknown address")
          : "unknown address";
      errors.push(
        `RentEngine /units record at index ${i} (id ${idHint}, ${addressHint}) failed to parse — ` +
          `${result.error.message} — skipped, other listings still processed`
      );
      continue;
    }

    const u = result.data;
    if (!isOnMarketStatus(u.status)) continue;

    listings.push({
      id: u.id,
      status: u.status,
      askingRent: u.target_rental_rate,
      monthlyFees: (u.monthly_fees ?? []).map((f) => ({ label: f.name, amount: f.amount })),
      address: u.address
        ? {
            streetNumber: u.address.street_number ?? null,
            streetName: u.address.street_name ?? null,
            unit: u.address.unit ?? null,
            city: u.address.city ?? null,
            formattedAddress: u.address.formatted_address ?? null,
          }
        : null,
    });
  }

  return { listings, errors };
}

// Fetches every RentEngine-tracked unit and returns only the on-market
// ones (see isOnMarketStatus), plus any per-record parse errors (see
// RentEngineFetchResult). Confirmed live: /units returns a bare JSON array,
// ~70-100 records total for this account, no pagination needed.
export async function fetchVacantListings(): Promise<RentEngineFetchResult> {
  const env = loadEnv();
  if (!env.RENTENGINE_API_KEY || !env.RENTENGINE_BASE_URL) {
    throw new RentEngineNotConfiguredError();
  }

  const res = await fetch(`${env.RENTENGINE_BASE_URL}/units?limit=100`, {
    headers: {
      Authorization: `Bearer ${env.RENTENGINE_API_KEY}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new Error(`RentEngine API error ${res.status} on /units: ${body}`);
  }
  const json = await res.json();
  return parseRentEngineUnitsResponse(json);
}
