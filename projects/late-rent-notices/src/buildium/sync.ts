import type { Pool } from "pg";
import { fetchActiveLeases, fetchProperties } from "./client.js";
import { getDefaultGracePeriodDays, getInheritedLeaseGracePeriodDays } from "../lib/config.js";
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
// grace-period field anywhere in Buildium's API, AND no field identifying a
// lease as "inherited" from a prior management company either. Grace period
// is driven by two config values Jason sets directly (see
// src/lib/config.ts getDefaultGracePeriodDays / getInheritedLeaseGracePeriodDays),
// not something synced from Buildium.
export async function syncBuildiumData(
  jobPool: Pool
): Promise<{ propertiesSynced: number; leasesSynced: number; propertiesDeactivated: number }> {
  const now = new Date();
  // Defaults applied ONLY to a lease's first sync, or (for the inherited
  // value) the moment fee_terms_source is first observed as inherited_lease
  // with no sign of a prior manual override — see the ON CONFLICT handling
  // below. Jason: grace period is NOT one company-wide number — leases
  // inherited from a prior management company carry a different late-fee
  // policy (14-Day Notice on day 6 instead of day 4). Buildium has no signal
  // for "this lease is inherited" — the only signal this system has is
  // leases.fee_terms_source (migration 0023), which is set by a human, not
  // synced from Buildium. Either default can still be overridden per-lease
  // via PATCH /api/leases/:id/grace-period.
  const { days: standardGracePeriodDays } = await getDefaultGracePeriodDays(jobPool);
  const { days: inheritedGracePeriodDays } = await getInheritedLeaseGracePeriodDays(jobPool);

  const properties = await fetchProperties();
  // fetchProperties() is already server-side filtered to status=Active
  // (client.ts), so every row reaching this loop is active in Buildium
  // today — is_active = true is set unconditionally on both insert and
  // update, including for a property that was previously marked inactive
  // here and has since come back under management (e.g. re-listed).
  for (const p of properties) {
    await jobPool.query(
      `INSERT INTO properties (
         buildium_property_id, source, name, address_line1, address_line2,
         city, state, postal_code, owner_buildium_id, synced_at, is_active
       ) VALUES ($1,'buildium',$2,$3,$4,$5,$6,$7,$8,$9,true)
       ON CONFLICT (buildium_property_id) DO UPDATE SET
         name = EXCLUDED.name,
         address_line1 = EXCLUDED.address_line1,
         address_line2 = EXCLUDED.address_line2,
         city = EXCLUDED.city,
         state = EXCLUDED.state,
         postal_code = EXCLUDED.postal_code,
         owner_buildium_id = EXCLUDED.owner_buildium_id,
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

  // Deactivation: a property that WAS active (is_active = true locally) but
  // is absent from this run's fetchProperties() result has stopped being
  // active in Buildium since the last sync (sold, taken off management,
  // etc.) — mark it inactive here rather than leaving it silently untouched
  // (the old UPSERT-only design had no path for this at all, which is how
  // 126 stale properties accumulated as "active" in the first place). Never
  // a DELETE — history (leases, notices, audit_log) referencing this
  // property row must stay intact, per Jason's explicit instruction.
  const activeBuildiumIds = properties.map((p) => String(p.Id));
  const deactivated = await jobPool.query<{ id: number; name: string }>(
    `UPDATE properties
       SET is_active = false
       WHERE is_active = true
         AND buildium_property_id != ALL($1::text[])
       RETURNING id, name`,
    [activeBuildiumIds]
  );
  if (deactivated.rows.length > 0) {
    logInfo("buildium sync: properties deactivated (no longer active in Buildium)", {
      count: deactivated.rows.length,
      propertyIds: deactivated.rows.map((r) => r.id),
    });
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

    // grace_period_days on INSERT: a brand-new lease has no fee_terms_source
    // yet (Buildium supplies none), so the column default of
    // 'limehouse_standard' (migration 0023) applies and the standard grace
    // period is used. If a human has already flagged fee_terms_source as
    // inherited_lease by the time this row is (re-)synced — see the
    // ON CONFLICT branch below — the inherited default is applied instead,
    // without a second, separate manual grace-period entry.
    //
    // On UPDATE (existing lease), grace_period_days is auto-corrected ONLY
    // when: (a) fee_terms_source on the existing row is inherited_lease, AND
    // (b) grace_period_days still equals the standard default, i.e. nothing
    // suggests a PM has already manually corrected it. This is the same
    // never-clobber-a-manual-override guarantee the prior code had (which
    // never touched grace_period_days on UPDATE at all) — it just also
    // closes the gap where fee_terms_source was set to inherited_lease but
    // grace_period_days was left at the standard number because no one
    // remembered the second manual step.
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
         synced_at = EXCLUDED.synced_at,
         grace_period_days = CASE
           WHEN leases.fee_terms_source = 'inherited_lease'
                AND leases.grace_period_days = $9
           THEN $10
           ELSE leases.grace_period_days
         END
       RETURNING id`,
      [
        String(lease.Id),
        propertyId,
        String(lease.UnitId),
        lease.UnitNumber ?? String(lease.UnitId),
        lease.PaymentDueDay,
        standardGracePeriodDays,
        lease.LeaseStatus,
        now,
        standardGracePeriodDays,
        inheritedGracePeriodDays,
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

  logInfo("buildium sync complete", {
    propertiesSynced: properties.length,
    leasesSynced,
    propertiesDeactivated: deactivated.rows.length,
  });
  return { propertiesSynced: properties.length, leasesSynced, propertiesDeactivated: deactivated.rows.length };
}
