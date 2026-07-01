import type { Pool } from "pg";
import { fetchActiveLeases, fetchProperties } from "./client.js";
import { getDefaultGracePeriodDays } from "../lib/config.js";
import { logInfo } from "../lib/appLogger.js";

// Pulls the current state of properties/leases/tenants/PM-assignment from
// Buildium into our local read-only cache tables. Run by the daily job
// before lateness is computed — never written to by anything except this
// sync and never the source of truth itself (Buildium is).
//
// CONFIRMED against the real Buildium API (OpenAPI spec + live calls):
// RentalManager comes back EMBEDDED on every /v1/rentals row, so PM
// assignment needs no separate API call — the earlier version of this file
// called a staff-assignments endpoint that doesn't exist. There is also no
// grace-period field anywhere in Buildium's API; grace period is a config
// value Jason sets directly (see src/lib/config.ts getGracePeriodDays),
// not something synced from Buildium.
export async function syncBuildiumData(jobPool: Pool): Promise<{ propertiesSynced: number; leasesSynced: number }> {
  const now = new Date();
  // Default applied ONLY to a lease's first sync (see ON CONFLICT below,
  // which deliberately never touches grace_period_days on update). Jason:
  // grace period is NOT one company-wide number — leases inherited from a
  // prior management company often carry a different late-fee policy. This
  // default just gives a new lease a starting value; override it per-lease
  // via PATCH /api/leases/:id/grace-period for anything non-standard.
  const { days: defaultGracePeriodDays } = await getDefaultGracePeriodDays(jobPool);

  const properties = await fetchProperties();
  for (const p of properties) {
    await jobPool.query(
      `INSERT INTO properties (
         buildium_property_id, source, name, address_line1, address_line2,
         city, state, postal_code, owner_buildium_id, synced_at
       ) VALUES ($1,'buildium',$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (buildium_property_id) DO UPDATE SET
         name = EXCLUDED.name,
         address_line1 = EXCLUDED.address_line1,
         address_line2 = EXCLUDED.address_line2,
         city = EXCLUDED.city,
         state = EXCLUDED.state,
         postal_code = EXCLUDED.postal_code,
         owner_buildium_id = EXCLUDED.owner_buildium_id,
         synced_at = EXCLUDED.synced_at`,
      [
        String(p.Id),
        p.Name ?? `Property ${p.Id}`,
        p.Address.AddressLine1 ?? "",
        p.Address.AddressLine2 ?? null,
        p.Address.City ?? "",
        p.Address.State ?? "",
        p.Address.PostalCode ?? "",
        null, // RentalOwnerId not exposed on RentalMessage; not needed by this build
        now,
      ]
    );

    // PM assignment: RentalManager is embedded directly on the property —
    // no separate fetch. A PM logs into the dashboard via Entra first
    // (which creates their pm_users row); until that's happened for a given
    // manager, this link is skipped and picked up on the next sync once
    // they exist locally — matching the prior design's intent, just with
    // one fewer API call to get there.
    if (p.RentalManager?.Email) {
      const propertyRow = await jobPool.query<{ id: number }>(
        "SELECT id FROM properties WHERE buildium_property_id = $1",
        [String(p.Id)]
      );
      const pmRow = await jobPool.query<{ id: number }>(
        "SELECT id FROM pm_users WHERE email = $1",
        [p.RentalManager.Email]
      );
      if (propertyRow.rows.length > 0 && pmRow.rows.length > 0) {
        await jobPool.query(
          `INSERT INTO pm_property_assignments (pm_user_id, property_id, source, buildium_staff_id, synced_at)
           VALUES ($1,$2,'buildium',$3,$4)
           ON CONFLICT (pm_user_id, property_id) DO UPDATE SET
             buildium_staff_id = EXCLUDED.buildium_staff_id,
             synced_at = EXCLUDED.synced_at`,
          [pmRow.rows[0].id, propertyRow.rows[0].id, String(p.RentalManager.Id), now]
        );
      }
    }
  }

  const leases = await fetchActiveLeases();
  let leasesSynced = 0;
  for (const lease of leases) {
    const propertyRow = await jobPool.query<{ id: number }>(
      "SELECT id FROM properties WHERE buildium_property_id = $1",
      [String(lease.PropertyId)]
    );
    if (propertyRow.rows.length === 0) {
      // Property not yet synced (shouldn't happen if properties synced
      // first in this same run) — skip and let the next run pick it up,
      // rather than guessing a property row into existence.
      continue;
    }
    const propertyId = propertyRow.rows[0].id;

    // grace_period_days is set ONLY on INSERT (the default, above) — the
    // ON CONFLICT clause deliberately does NOT include it, so a PM's manual
    // per-lease override (e.g. for an inherited tenant with a different
    // late-fee policy) is never clobbered by the next daily sync.
    const leaseUpsert = await jobPool.query<{ id: number }>(
      `INSERT INTO leases (
         buildium_lease_id, source, property_id, unit_buildium_id, unit_label,
         rent_due_day, grace_period_days, lease_status, synced_at
       ) VALUES ($1,'buildium',$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (buildium_lease_id) DO UPDATE SET
         property_id = EXCLUDED.property_id,
         unit_buildium_id = EXCLUDED.unit_buildium_id,
         unit_label = EXCLUDED.unit_label,
         rent_due_day = EXCLUDED.rent_due_day,
         lease_status = EXCLUDED.lease_status,
         synced_at = EXCLUDED.synced_at
       RETURNING id`,
      [
        String(lease.Id),
        propertyId,
        String(lease.UnitId),
        lease.UnitNumber ?? String(lease.UnitId),
        lease.PaymentDueDay,
        defaultGracePeriodDays,
        lease.LeaseStatus,
        now,
      ]
    );
    const leaseId = leaseUpsert.rows[0].id;

    for (const tenant of lease.CurrentTenants ?? []) {
      if (!tenant.Email) {
        // A tenant with no email on file can't receive an email-only
        // notice — log this via audit trail in the daily job itself
        // (which has lease context), not silently dropped here.
        continue;
      }
      await jobPool.query(
        `INSERT INTO lease_tenants (
           lease_id, buildium_tenant_id, source, full_name, email, is_primary, synced_at
         ) VALUES ($1,$2,'buildium',$3,$4,false,$5)
         ON CONFLICT (lease_id, buildium_tenant_id) DO UPDATE SET
           full_name = EXCLUDED.full_name,
           email = EXCLUDED.email,
           synced_at = EXCLUDED.synced_at`,
        [
          leaseId,
          String(tenant.Id),
          `${tenant.FirstName ?? ""} ${tenant.LastName ?? ""}`.trim() || "Tenant",
          tenant.Email,
          now,
        ]
      );
    }
    leasesSynced += 1;
  }

  logInfo("buildium sync complete", { propertiesSynced: properties.length, leasesSynced });
  return { propertiesSynced: properties.length, leasesSynced };
}
