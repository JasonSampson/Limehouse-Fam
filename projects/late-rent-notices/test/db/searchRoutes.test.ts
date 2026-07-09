import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestSuperuserPool, withTestPmScope, truncateAllTables, closeAllTestPools } from "../support/testDb.js";
import {
  seedPmUser,
  seedProperty,
  seedPmPropertyAssignment,
  seedLease,
  seedActiveConfigValue,
  seedLetterTemplate,
  seedLateCycle,
  seedNotice,
} from "../support/seed.js";

// The exact queries searchRoutes.ts's GET /api/search runs, exercised
// against real seeded rows through the real late_rent_app RLS-subject
// role (not superuser) — same pattern as rls.test.ts. Confirms: address
// matching works (partial, case-insensitive), a plain PM only finds
// results within their own assigned doors (RLS still applies to a search,
// it isn't a backdoor around door-scoping), and — unlike the dashboard
// list — a voided notice still shows up here, since a deliberate address
// lookup should surface full history, not just what still needs action.
async function runNoticeSearch(client: import("pg").PoolClient, likePattern: string) {
  const result = await client.query(
    `SELECT n.id, n.status, p.name AS property_name, p.address_line1
     FROM notices n
     JOIN leases l ON l.id = n.lease_id
     JOIN properties p ON p.id = l.property_id
     WHERE p.address_line1 ILIKE $1 OR p.name ILIKE $1
     ORDER BY n.drafted_at DESC`,
    [likePattern]
  );
  return result.rows;
}

describe("search — GET /api/search query logic", () => {
  const superuser = getTestSuperuserPool();
  let pmA: number;
  let pmB: number;
  let propertyPoppy: number;
  let propertyOther: number;
  let deMinimisConfigId: number;
  let letterTemplateId: number;

  beforeAll(async () => {
    await truncateAllTables();
    pmA = await seedPmUser(superuser, { email: "pm-a-search@limehousepm.com", role: "pm" });
    pmB = await seedPmUser(superuser, { email: "pm-b-search@limehousepm.com", role: "pm" });

    propertyPoppy = await seedProperty(superuser, { buildiumPropertyId: "PROP-POPPY", name: "9109 Poppy Court" });
    propertyOther = await seedProperty(superuser, { buildiumPropertyId: "PROP-OTHER", name: "Other Street Apts" });
    await seedPmPropertyAssignment(superuser, pmA, propertyPoppy);
    await seedPmPropertyAssignment(superuser, pmB, propertyOther);

    deMinimisConfigId = await seedActiveConfigValue(superuser, {
      configKey: "de_minimis_threshold_usd",
      value: 100,
      setByPmId: pmA,
    });
    letterTemplateId = await seedLetterTemplate(superuser, { createdByPmId: pmA });

    const leasePoppy = await seedLease(superuser, { buildiumLeaseId: "POPPY-LEASE", propertyId: propertyPoppy });
    const lateCyclePoppy = await seedLateCycle(superuser, { leaseId: leasePoppy, deMinimisConfigId });
    const noticePoppy = await seedNotice(superuser, {
      lateCycleId: lateCyclePoppy,
      leaseId: leasePoppy,
      letterTemplateId,
      assignedPmId: pmA,
    });
    // A voided-and-never-sent notice, same as the dashboard-hiding feature
    // — search must still find it (unlike GET /api/notices).
    await superuser.query(
      "UPDATE notices SET status = 'voided', voided_at = now(), voided_reason = 'test' WHERE id = $1",
      [noticePoppy]
    );

    const leaseOther = await seedLease(superuser, { buildiumLeaseId: "OTHER-LEASE", propertyId: propertyOther });
    const lateCycleOther = await seedLateCycle(superuser, { leaseId: leaseOther, deMinimisConfigId });
    await seedNotice(superuser, {
      lateCycleId: lateCycleOther,
      leaseId: leaseOther,
      letterTemplateId,
      assignedPmId: pmB,
    });
  });

  afterAll(async () => {
    await closeAllTestPools();
  });

  it("finds a notice by a partial, case-insensitive address match", async () => {
    const rows = await withTestPmScope({ pmUserId: pmA, pmRole: "pm" }, (client) => runNoticeSearch(client, "%poppy%"));
    expect(rows).toHaveLength(1);
    expect(rows[0].property_name).toBe("9109 Poppy Court");
  });

  it("still returns a voided-and-never-sent notice — search shows full history, unlike the dashboard list", async () => {
    const rows = await withTestPmScope({ pmUserId: pmA, pmRole: "pm" }, (client) => runNoticeSearch(client, "%poppy%"));
    expect(rows[0].status).toBe("voided");
  });

  it("a plain PM's search only finds results within their own assigned doors (RLS still applies)", async () => {
    // pmB is not assigned to the Poppy Court property — searching for it
    // from pmB's session should find nothing, same door-scoping as every
    // other RLS-protected route.
    const rows = await withTestPmScope({ pmUserId: pmB, pmRole: "pm" }, (client) => runNoticeSearch(client, "%poppy%"));
    expect(rows).toHaveLength(0);
  });

  it("returns no results for a search term matching nothing", async () => {
    const rows = await withTestPmScope({ pmUserId: pmA, pmRole: "pm" }, (client) =>
      runNoticeSearch(client, "%nonexistent-address-xyz%")
    );
    expect(rows).toHaveLength(0);
  });
});
