import type { Pool } from "pg";
import { loadEnv } from "../config/env.js";
import { fetchVacantListings, RentEngineNotConfiguredError } from "./client.js";
import { matchProperty, matchUnit, type PropertyRow, type UnitRow } from "./addressMatch.js";
import { isExcludedFromDisplay } from "../lib/feeClassification.js";
import { logInfo, logWarn } from "../lib/appLogger.js";

export interface RentEngineSyncOutcome {
  configured: boolean;
  listingsSynced: number; // on-market RentEngine listings considered this run
  matched: number;
  unmatched: number;
  recurringChargesSynced: number;
  errors: string[];
  note: string;
}

// Matches real RentEngine listings to real Buildium properties/units by
// address (see addressMatch.ts) and upserts into vacant_unit_asking_rents.
// Built 2026-07-21 once Jason confirmed directly that address is the only
// matching key he/his team can rely on — RentEngine's own listing id has no
// relationship to Buildium's ids and isn't used here (see addressMatch.ts
// header for the full reasoning).
export async function syncVacantUnitAskingRents(jobPool: Pool): Promise<RentEngineSyncOutcome> {
  const env = loadEnv();

  if (!env.RENTENGINE_API_KEY || !env.RENTENGINE_BASE_URL) {
    const note =
      "RentEngine sync skipped: RENTENGINE_API_KEY / RENTENGINE_BASE_URL not configured. " +
      "This is a documented, expected gap — no vacant-unit asking rent data was synced this run; " +
      "the map will fall back to showing no asking-rent figure for vacant units.";
    logWarn("rentengine sync: not configured, stub ran as documented", {});
    return {
      configured: false,
      listingsSynced: 0,
      matched: 0,
      unmatched: 0,
      recurringChargesSynced: 0,
      errors: [],
      note,
    };
  }

  let listings;
  // Errors from parsing the raw /units response itself (e.g. one record's
  // monthly_fees didn't match the expected shape) — collected before the
  // matching loop below adds its own per-listing "no confident match"
  // errors to the same array.
  let fetchErrors: string[];
  try {
    ({ listings, errors: fetchErrors } = await fetchVacantListings());
  } catch (err) {
    if (err instanceof RentEngineNotConfiguredError) {
      return {
        configured: false,
        listingsSynced: 0,
        matched: 0,
        unmatched: 0,
        recurringChargesSynced: 0,
        errors: [],
        note: err.message,
      };
    }
    throw err;
  }

  const now = new Date();
  const errors: string[] = [...fetchErrors];
  let matched = 0;
  let recurringChargesSynced = 0;

  // is_active filter mirrors every other Map query — a property Buildium
  // no longer considers active shouldn't be a match target even if its
  // address happens to line up with a stale RentEngine listing.
  const properties = (
    await jobPool.query<PropertyRow>(
      "SELECT id, address_line1, address_line2, city FROM properties WHERE is_active = true"
    )
  ).rows;

  for (const listing of listings) {
    const label = listing.address?.formattedAddress ?? `RentEngine unit ${listing.id}`;

    if (!listing.address || listing.askingRent === null) {
      errors.push(`RentEngine listing ${listing.id} (${label}): missing address or asking rent, skipped`);
      continue;
    }

    const propertyMatch = matchProperty(
      {
        streetNumber: listing.address.streetNumber,
        streetName: listing.address.streetName,
        unit: listing.address.unit,
        city: listing.address.city,
        formattedAddress: listing.address.formattedAddress,
      },
      properties
    );

    if (propertyMatch.status !== "matched" || !propertyMatch.property) {
      errors.push(
        `RentEngine listing ${listing.id} (${label}): ${
          propertyMatch.status === "ambiguous"
            ? "matched more than one active Buildium property, no confident match"
            : "no matching active Buildium property found"
        } — needs a manual look, not synced`
      );
      continue;
    }

    const units = (
      await jobPool.query<UnitRow>("SELECT id, unit_label FROM units WHERE property_id = $1", [
        propertyMatch.property.id,
      ])
    ).rows;

    const unitMatch = matchUnit(listing.address.unit, units);
    if ((unitMatch.status !== "matched" && unitMatch.status !== "not_needed") || !unitMatch.unit) {
      errors.push(
        `RentEngine listing ${listing.id} (${label}): matched property "${propertyMatch.property.address_line1}" ` +
          `(id ${propertyMatch.property.id}) but could not confidently match one of its ${units.length} unit(s) ` +
          `— needs a manual look, not synced`
      );
      continue;
    }

    const askingRentUpsert = await jobPool.query<{ id: number }>(
      `INSERT INTO vacant_unit_asking_rents (unit_id, rentengine_listing_id, asking_rent, synced_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (rentengine_listing_id) DO UPDATE SET
         unit_id = EXCLUDED.unit_id,
         asking_rent = EXCLUDED.asking_rent,
         synced_at = EXCLUDED.synced_at
       RETURNING id`,
      [unitMatch.unit.id, String(listing.id), listing.askingRent, now]
    );
    matched += 1;

    // --- Recurring charges beyond asking rent ---
    // This listing's monthly_fees fetch is authoritative for it (same rule
    // as the Buildium side, Neo's schema.md note on migration 0018): clear
    // any charge label no longer present before upserting the current set.
    const vacantUnitAskingRentId = askingRentUpsert.rows[0].id;
    const currentLabels = listing.monthlyFees.map((f) => f.label);
    await jobPool.query(
      `DELETE FROM vacant_listing_recurring_charges
         WHERE vacant_unit_asking_rent_id = $1 AND label != ALL($2::text[])`,
      [vacantUnitAskingRentId, currentLabels]
    );
    for (const fee of listing.monthlyFees) {
      await jobPool.query(
        `INSERT INTO vacant_listing_recurring_charges (
           vacant_unit_asking_rent_id, label, amount, excluded_from_display, synced_at
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (vacant_unit_asking_rent_id, label) DO UPDATE SET
           amount = EXCLUDED.amount,
           excluded_from_display = EXCLUDED.excluded_from_display,
           synced_at = EXCLUDED.synced_at`,
        [vacantUnitAskingRentId, fee.label, fee.amount, isExcludedFromDisplay(fee.label), now]
      );
      recurringChargesSynced += 1;
    }
  }

  const unmatched = listings.length - matched;
  logInfo("rentengine sync: address-matching complete", {
    listingsSynced: listings.length,
    matched,
    unmatched,
  });

  return {
    configured: true,
    listingsSynced: listings.length,
    matched,
    unmatched,
    recurringChargesSynced,
    errors,
    note: `Synced ${matched} of ${listings.length} on-market RentEngine listing(s) to vacant_unit_asking_rents; ${unmatched} could not be confidently matched to a Buildium property/unit.`,
  };
}
