import { describe, it, expect } from "vitest";
import { buildTenantStayRows, averageTenantTenancyMonths } from "../../src/kpi/tenancy.js";
import type { BuildiumTenantWithLeases, BuildiumLease } from "../../src/buildium/client.js";

function leaseFor(
  tenantId: number,
  overrides: Partial<BuildiumLease> & { status: "Current" | "MovedOut" | "Future"; moveIn: string; moveOut?: string | null }
): BuildiumLease {
  const { status, moveIn, moveOut, ...leaseOverrides } = overrides;
  return {
    Id: 1,
    PropertyId: 100,
    UnitId: 10,
    UnitNumber: "1",
    LeaseStatus: "Active",
    LeaseType: "Fixed",
    LeaseFromDate: moveIn,
    LeaseToDate: null,
    IsEvictionPending: false,
    PaymentDueDay: 1,
    CurrentTenants: null,
    MoveOutData: moveOut ? [{ TenantId: tenantId, MoveOutDate: moveOut, NoticeGivenDate: null }] : [],
    Tenants: [{ Id: tenantId, Status: status, MoveInDate: moveIn }],
    ...leaseOverrides,
  };
}

function tenant(overrides: Partial<BuildiumTenantWithLeases>): BuildiumTenantWithLeases {
  return {
    Id: 1,
    FirstName: "Jane",
    LastName: "Doe",
    Leases: [],
    ...overrides,
  };
}

describe("buildTenantStayRows", () => {
  const asOf = new Date("2026-07-12T00:00:00Z");

  it("measures a current tenant from their real move-in date up to today, not a lease end date", () => {
    const t = tenant({
      Id: 1,
      Leases: [leaseFor(1, { status: "Current", moveIn: "2026-01-12", LeaseToDate: "2026-12-31" })],
    });
    const rows = buildTenantStayRows([t], asOf);
    expect(rows).toHaveLength(1);
    // 2026-01-12 to 2026-07-12 is exactly 6 calendar months, but tenancy is
    // measured as elapsed days / 30.44 (avg days/month), not calendar-month
    // arithmetic, so this lands at 5.9 -- an intentional approximation.
    expect(rows[0]).toMatchObject({ tenantId: "1", movedIn: "2026-01-12", movedOut: null, tenancyMonths: 5.9 });
  });

  it("measures a past tenant from move-in to their real move-out date", () => {
    const t = tenant({
      Id: 2,
      Leases: [leaseFor(2, { status: "MovedOut", moveIn: "2025-01-12", moveOut: "2025-07-12" })],
    });
    const rows = buildTenantStayRows([t], asOf);
    expect(rows[0]).toMatchObject({ tenantId: "2", movedIn: "2025-01-12", movedOut: "2025-07-12", tenancyMonths: 5.9 });
  });

  it("excludes a tenant who hasn't moved in yet (Future status)", () => {
    const t = tenant({ Id: 3, Leases: [leaseFor(3, { status: "Future", moveIn: "2026-08-01" })] });
    const rows = buildTenantStayRows([t], asOf);
    expect(rows).toHaveLength(0);
  });

  it("skips a MovedOut record with no real MoveOutDate on file rather than guessing", () => {
    const t = tenant({
      Id: 4,
      Leases: [
        {
          ...leaseFor(4, { status: "MovedOut", moveIn: "2025-01-01" }),
          MoveOutData: [], // no matching MoveOutData entry
        },
      ],
    });
    const rows = buildTenantStayRows([t], asOf);
    expect(rows).toHaveLength(0);
  });

  it("uses the tenant's real name from the top-level tenant record", () => {
    const t = tenant({
      Id: 5,
      FirstName: "Ruth",
      LastName: "Bullock",
      Leases: [leaseFor(5, { status: "MovedOut", moveIn: "2020-03-12", moveOut: "2024-03-31" })],
    });
    const rows = buildTenantStayRows([t], asOf);
    expect(rows[0].tenantName).toBe("Ruth Bullock");
  });

  it("merges two separate stays by the same tenant in the SAME unit into one row (earliest move-in, latest move-out)", () => {
    const t = tenant({
      Id: 6,
      Leases: [
        leaseFor(6, { Id: 101, UnitId: 10, status: "MovedOut", moveIn: "2015-05-22", moveOut: "2018-05-01" }),
        leaseFor(6, { Id: 102, UnitId: 10, status: "MovedOut", moveIn: "2018-06-01", moveOut: "2020-06-01" }),
      ],
    });
    const rows = buildTenantStayRows([t], asOf);
    expect(rows).toHaveLength(1);
    expect(rows[0].movedIn).toBe("2015-05-22");
    expect(rows[0].movedOut).toBe("2020-06-01");
  });

  it("keeps two stays by the same tenant in DIFFERENT units as two separate rows", () => {
    const t = tenant({
      Id: 7,
      Leases: [
        leaseFor(7, { Id: 201, UnitId: 10, status: "MovedOut", moveIn: "2018-03-28", moveOut: "2022-06-25" }),
        leaseFor(7, { Id: 202, UnitId: 20, status: "Current", moveIn: "2022-06-25" }),
      ],
    });
    const rows = buildTenantStayRows([t], asOf);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.unitId).sort()).toEqual(["10", "20"]);
  });

  it("a current stay in the group wins even if an older record on the same unit shows MovedOut", () => {
    // co-tenant scenario: one Tenants[] entry could theoretically show
    // MovedOut on an older lease record while a newer record on the same
    // unit shows Current -- Current must win, since the tenant is still there.
    const t = tenant({
      Id: 8,
      Leases: [
        leaseFor(8, { Id: 301, UnitId: 10, status: "MovedOut", moveIn: "2015-05-22", moveOut: "2018-05-01" }),
        leaseFor(8, { Id: 302, UnitId: 10, status: "Current", moveIn: "2018-06-01" }),
      ],
    });
    const rows = buildTenantStayRows([t], asOf);
    expect(rows).toHaveLength(1);
    expect(rows[0].movedOut).toBeNull();
  });

  it("sorts rows longest tenancy first", () => {
    const t1 = tenant({ Id: 9, Leases: [leaseFor(9, { status: "Current", moveIn: "2026-06-12" })] }); // 1 month
    const t2 = tenant({ Id: 10, Leases: [leaseFor(10, { status: "Current", moveIn: "2025-01-12" })] }); // 18 months
    const rows = buildTenantStayRows([t1, t2], asOf);
    expect(rows.map((r) => r.tenantId)).toEqual(["10", "9"]);
  });
});

describe("averageTenantTenancyMonths", () => {
  it("averages tenancyMonths across all rows", () => {
    const rows = [
      { tenantId: "1", tenantName: null, propertyId: "1", unitId: "1", unitNumber: null, movedIn: "x", movedOut: null, tenancyMonths: 10 },
      { tenantId: "2", tenantName: null, propertyId: "1", unitId: "2", unitNumber: null, movedIn: "x", movedOut: null, tenancyMonths: 20 },
    ];
    expect(averageTenantTenancyMonths(rows)).toBe(15);
  });

  it("returns null for an empty list rather than 0 or NaN", () => {
    expect(averageTenantTenancyMonths([])).toBeNull();
  });
});
