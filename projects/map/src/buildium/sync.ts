import type { Pool } from "pg";
import {
  fetchProperties,
  fetchUnitsForProperty,
  fetchLeasesForProperty,
  currentRentFromLease,
  getPrimaryPhone,
  parseUnitNumericField,
} from "./client.js";
import { logInfo } from "../lib/appLogger.js";

export interface BuildiumSyncResult {
  propertiesSynced: number;
  unitsSynced: number;
  leasesSynced: number;
  propertiesDeactivated: number;
  errors: string[];
}

// Pulls properties, units, leases, and tenants from Buildium into Map's
// own tables. Mirrors late-rent-notices' syncBuildiumData (same
// deactivate-never-delete rule, same "insert what came back, then mark
// absent-but-previously-active rows inactive" shape) extended with units
// and full lease history (Active/Future/Past, not just Active) per Neo's
// schema.md.
export async function syncBuildiumData(jobPool: Pool): Promise<BuildiumSyncResult> {
  const now = new Date();
  const errors: string[] = [];

  const properties = await fetchProperties();
  for (const p of properties) {
    await jobPool.query(
      `INSERT INTO properties (
         buildium_property_id, source, name, address_line1, address_line2,
         city, state, postal_code, synced_at, is_active
       ) VALUES ($1,'buildium',$2,$3,$4,$5,$6,$7,$8,true)
       ON CONFLICT (buildium_property_id) DO UPDATE SET
         name = EXCLUDED.name,
         address_line1 = EXCLUDED.address_line1,
         address_line2 = EXCLUDED.address_line2,
         city = EXCLUDED.city,
         state = EXCLUDED.state,
         postal_code = EXCLUDED.postal_code,
         synced_at = EXCLUDED.synced_at,
         is_active = true`,
      [
        String(p.Id),
        p.Name ?? `Property ${p.Id}`,
        p.Address.AddressLine1 ?? "",
        p.Address.AddressLine2 ?? null,
        p.Address.City ?? "",
        p.Address.State ?? "",
        p.Address.PostalCode ?? "",
        now,
      ]
    );
  }

  // Deactivation: never a DELETE. A property absent from this run's
  // fetchProperties() result has stopped being active in Buildium since
  // the last sync — mirrors b71080e exactly. The row (and any
  // property_exclusions/public_map_locations row referencing it) persists
  // forever.
  const activeBuildiumIds = properties.map((p) => String(p.Id));
  const deactivated = await jobPool.query<{ id: number }>(
    `UPDATE properties
       SET is_active = false
       WHERE is_active = true
         AND buildium_property_id != ALL($1::text[])
       RETURNING id`,
    [activeBuildiumIds]
  );
  if (deactivated.rows.length > 0) {
    logInfo("buildium sync: properties deactivated (no longer active in Buildium)", {
      count: deactivated.rows.length,
    });
  }

  let unitsSynced = 0;
  let leasesSynced = 0;

  for (const p of properties) {
    const propertyRow = await jobPool.query<{ id: number }>(
      "SELECT id FROM properties WHERE buildium_property_id = $1",
      [String(p.Id)]
    );
    if (propertyRow.rows.length === 0) continue; // shouldn't happen; defensive
    const propertyId = propertyRow.rows[0].id;

    // --- Units ---
    let units;
    try {
      units = await fetchUnitsForProperty(p.Id);
    } catch (err) {
      // One property's unit fetch failing must not abort the whole sync —
      // collect it as a per-item error (surfaced via sync_runs.error_message
      // and a real alert, per mapJobRunner.ts) and keep going.
      errors.push(
        `Property ${propertyId} (Buildium ${p.Id}): failed to fetch units — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      continue;
    }

    const unitIdByBuildiumId = new Map<number, number>();
    for (const u of units) {
      const upserted = await jobPool.query<{ id: number }>(
        `INSERT INTO units (
           property_id, buildium_unit_id, unit_label, bedrooms, bathrooms, square_feet, synced_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (buildium_unit_id) DO UPDATE SET
           property_id = EXCLUDED.property_id,
           unit_label = EXCLUDED.unit_label,
           bedrooms = EXCLUDED.bedrooms,
           bathrooms = EXCLUDED.bathrooms,
           square_feet = EXCLUDED.square_feet,
           synced_at = EXCLUDED.synced_at
         RETURNING id`,
        [
          propertyId,
          String(u.Id),
          u.UnitNumber ?? String(u.Id),
          parseUnitNumericField(u.UnitBedrooms),
          parseUnitNumericField(u.UnitBathrooms),
          u.UnitSize ?? null,
          now,
        ]
      );
      unitIdByBuildiumId.set(u.Id, upserted.rows[0].id);
      unitsSynced += 1;
    }

    // --- Leases + tenants ---
    let leases;
    try {
      leases = await fetchLeasesForProperty(p.Id);
    } catch (err) {
      errors.push(
        `Property ${propertyId} (Buildium ${p.Id}): failed to fetch leases — ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      continue;
    }

    for (const lease of leases) {
      const unitId = unitIdByBuildiumId.get(lease.UnitId);
      if (!unitId) {
        // Unit not yet synced this run (shouldn't happen since units sync
        // first, above) — skip and let the next run pick it up rather than
        // guessing a unit row into existence.
        errors.push(
          `Lease ${lease.Id} (Buildium property ${p.Id}): unit ${lease.UnitId} not found locally, skipped`
        );
        continue;
      }

      const leaseUpsert = await jobPool.query<{ id: number }>(
        `INSERT INTO leases (
           unit_id, buildium_lease_id, lease_status, lease_from, lease_to, current_rent, synced_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (buildium_lease_id) DO UPDATE SET
           unit_id = EXCLUDED.unit_id,
           lease_status = EXCLUDED.lease_status,
           lease_from = EXCLUDED.lease_from,
           lease_to = EXCLUDED.lease_to,
           current_rent = EXCLUDED.current_rent,
           synced_at = EXCLUDED.synced_at
         RETURNING id`,
        [
          unitId,
          String(lease.Id),
          lease.LeaseStatus,
          lease.LeaseFromDate,
          lease.LeaseToDate,
          currentRentFromLease(lease),
          now,
        ]
      );
      const leaseId = leaseUpsert.rows[0].id;

      for (const tenant of lease.CurrentTenants ?? []) {
        await jobPool.query(
          `INSERT INTO lease_tenants (
             lease_id, buildium_tenant_id, full_name, phone, is_primary, synced_at
           ) VALUES ($1,$2,$3,$4,false,$5)
           ON CONFLICT (lease_id, buildium_tenant_id) DO UPDATE SET
             full_name = EXCLUDED.full_name,
             phone = EXCLUDED.phone,
             synced_at = EXCLUDED.synced_at`,
          [
            leaseId,
            String(tenant.Id),
            `${tenant.FirstName ?? ""} ${tenant.LastName ?? ""}`.trim() || "Tenant",
            getPrimaryPhone(tenant),
            now,
          ]
        );
      }
      leasesSynced += 1;
    }
  }

  logInfo("buildium sync complete", {
    propertiesSynced: properties.length,
    unitsSynced,
    leasesSynced,
    propertiesDeactivated: deactivated.rows.length,
    errorCount: errors.length,
  });

  return {
    propertiesSynced: properties.length,
    unitsSynced,
    leasesSynced,
    propertiesDeactivated: deactivated.rows.length,
    errors,
  };
}
