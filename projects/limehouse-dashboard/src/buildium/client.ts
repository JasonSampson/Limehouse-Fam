import { z } from "zod";
import { loadEnv } from "../config/env.js";
import { buildiumLimiter } from "../lib/globalRequestLimiter.js";

// Adapted from late-rent-notices/src/buildium/client.ts — same proven auth
// pattern, error handling, and pagination style, confirmed against
// Buildium's real API for this same account. This project uses its OWN
// fresh Buildium API key (see .env.example) so it can be revoked
// independently of late-rent-notices.
function buildiumHeaders(): Record<string, string> {
  const env = loadEnv();
  return {
    "x-buildium-client-id": env.BUILDIUM_CLIENT_ID,
    "x-buildium-client-secret": env.BUILDIUM_CLIENT_SECRET,
    Accept: "application/json",
  };
}

export class BuildiumApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
    this.name = "BuildiumApiError";
  }
}

// CONFIRMED LIVE 2026-07-03 against Jason's real Buildium account: a burst
// of ~230 rapid sequential per-lease calls (one per active lease, e.g. the
// old rent-collection transactions loop) hits Buildium's rate limit and
// gets back real 429 responses partway through. buildiumGet now retries a
// 429 with exponential backoff (honoring a Retry-After header if Buildium
// sends one) instead of surfacing the failure immediately — this makes any
// call site that happens to burst past the rate limit self-heal rather
// than fail outright. This does NOT replace fixing call sites that
// generate the burst in the first place (see fetchLeaseTransactions'
// caller in dashboardRoutes.ts, now cache-backed) — it's a safety net for
// any burst that still occurs, not a substitute for not bursting.
const MAX_RATE_LIMIT_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildiumGet<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, any>): Promise<T> {
  const env = loadEnv();

  let attempt = 0;
  for (;;) {
    // Only the actual HTTP attempt goes through the global spacer, not the
    // backoff sleep below — a retry's own wait is specific to THIS caller
    // and shouldn't hold up an unrelated caller's turn in the shared queue.
    const res = await buildiumLimiter.run(() => fetch(`${env.BUILDIUM_BASE_URL}${path}`, { headers: buildiumHeaders() }));

    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
      // Exponential backoff (500ms, 1s, 2s, 4s) as the fallback when
      // Buildium doesn't send a usable Retry-After header.
      const backoffMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 500 * 2 ** attempt;
      await sleep(backoffMs);
      attempt++;
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "<no body>");
      throw new BuildiumApiError(`Buildium API error ${res.status} on ${path}`, res.status, body);
    }
    const json = await res.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new BuildiumApiError(
        `Buildium API response for ${path} did not match expected shape: ${parsed.error.message}`,
        res.status,
        JSON.stringify(json)
      );
    }
    return parsed.data;
  }
}

// Generic pager for list endpoints that use Buildium's offset/limit
// convention. Buildium does not return a total count or "has more" flag on
// these endpoints (confirmed in late-rent-notices against the real API) —
// the only reliable signal that a page is the last one is getting back
// fewer rows than the page size requested. Capped at 50 pages (50,000 rows
// at the default page size) as a hard safety stop against an infinite loop
// if Buildium's pagination behavior ever changes unexpectedly.
async function buildiumGetAllPages<T>(
  pathWithoutPaging: string,
  schema: z.ZodType<T[], z.ZodTypeDef, any>,
  pageSize = 1000
): Promise<T[]> {
  const results: T[] = [];
  const sep = pathWithoutPaging.includes("?") ? "&" : "?";
  for (let page = 0; page < 50; page++) {
    const offset = page * pageSize;
    const rows = await buildiumGet<T[]>(`${pathWithoutPaging}${sep}limit=${pageSize}&offset=${offset}`, schema);
    results.push(...rows);
    if (rows.length < pageSize) break;
  }
  return results;
}

// ============================================================================
// Leases
// ============================================================================

const buildiumTenantSchema = z.object({
  Id: z.number(),
  FirstName: z.string().nullable(),
  LastName: z.string().nullable(),
  Email: z.string().email().nullable(),
});

// LeaseStatus values confirmed via OpenAPI spec + late-rent-notices live
// usage: Active/Past/Future. Renewal cadence fields (LeaseType,
// AutomaticallyMoveOutTenants/term info) are used below to distinguish
// fixed-term vs month-to-month for the Dashboard's lease-mix tiles.
//
// CONFIRMED LIVE 2026-07-03 against Jason's real Buildium account (first
// live credentials for this project): the guessed CurrentRent.Amount /
// SecurityDeposit.Amount nested shape was WRONG — a real lease response
// carries no CurrentRent or SecurityDeposit field at all. The actual rent
// and deposit figures live on a nested `AccountDetails` object:
// AccountDetails.Rent and AccountDetails.SecurityDeposit, both flat
// numbers (not {Amount: number} objects). This was the root cause of
// /api/dashboard/financials/rent-and-deposit always returning all-null —
// the old field paths simply didn't exist on the real response, so every
// value silently fell through to "no data" instead of erroring loudly.
const buildiumAccountDetailsSchema = z
  .object({
    Rent: z.number().nullable(),
    SecurityDeposit: z.number().nullable(),
  })
  .nullable();

const buildiumLeaseSchema = z.object({
  Id: z.number(),
  PropertyId: z.number(),
  UnitId: z.number(),
  UnitNumber: z.string().nullable(),
  LeaseStatus: z.enum(["Active", "Past", "Future"]),
  LeaseType: z.string().nullable(), // e.g. "Fixed", "FixedWithRollover", "AtWill" (month-to-month)
  LeaseFromDate: z.string().nullable(),
  LeaseToDate: z.string().nullable(),
  IsEvictionPending: z.boolean(),
  PaymentDueDay: z.number().int().min(1).max(31).nullable(),
  CurrentTenants: z.array(buildiumTenantSchema).nullable(),
  AccountDetails: buildiumAccountDetailsSchema.optional(),
  // ADDED 2026-07-05 for the trailing-12-month Renewal Rate rebuild (see
  // summarizeRenewalRate in src/kpi/occupancy.ts) — CONFIRMED LIVE this is
  // real and populated on every lease. Real Buildium accounts do NOT create
  // a new lease record when a tenant renews (confirmed: zero same-tenant
  // successor-lease matches found across 574 real leases when searching
  // for one) — a renewal instead extends LeaseToDate IN PLACE on the same
  // record, which is why 132 of 240 real Active leases were originally
  // created 2018-2021 yet still show LeaseStatus="Active" today with a
  // LastUpdatedDateTime from within the last few months. That gap between
  // CreatedDateTime and a recent LastUpdatedDateTime, combined with a
  // total lease term longer than a normal first year, is the only
  // available signal for "this lease was renewed," since Buildium doesn't
  // expose renewal history as its own record for this account (see
  // occupancy.ts for the full derivation and why /leases/renewals wasn't
  // usable here).
  LastUpdatedDateTime: z.string().nullable().optional(),
  // MoveOutData — ADDED 2026-07-12 for the Apps Per Vacancy drill-down.
  // CONFIRMED LIVE real field, one entry per tenant on the lease, each
  // with its own NoticeGivenDate — the date the outgoing tenant actually
  // gave notice, which is real weeks before MoveOutDate/LeaseToDate. This
  // matters because real applications for the NEXT tenant routinely start
  // coming in the moment notice is given, not on the day the old lease
  // technically ends (confirmed live: a real case, 1149 Birks Lane, had 7
  // real applicants apply 4+ weeks before the lease's own end date, all
  // of which the vacancy-cycle logic was silently missing before this).
  MoveOutData: z
    .array(z.object({ TenantId: z.number(), MoveOutDate: z.string().nullable(), NoticeGivenDate: z.string().nullable() }))
    .default([]),
  // Tenants — ADDED 2026-07-12 for the "every past and current tenant"
  // Avg Tenancy rebuild, per Jason directly. CONFIRMED LIVE this is a real
  // field on every lease (bulk /leases list AND /leases/tenants), present
  // even when CurrentTenants is empty (which it always is once a lease
  // goes Past — CurrentTenants only ever holds "who's there right now").
  // Status is "Current" | "MovedOut" | "Future"; MoveInDate is a real
  // per-tenant date, confirmed 0 nulls across 967 real tenant records on
  // this account. This is the ONLY reliable way to find out who lived in a
  // unit historically — CurrentTenants can't do it once they've moved out.
  Tenants: z
    .array(z.object({ Id: z.number(), Status: z.enum(["Current", "MovedOut", "Future"]), MoveInDate: z.string().nullable() }))
    .default([]),
});

export type BuildiumLease = z.infer<typeof buildiumLeaseSchema>;

const buildiumLeaseListSchema = z.array(buildiumLeaseSchema);

// Same confirmed endpoint/query-param behavior as late-rent-notices:
// leasestatuses is a real array query param; a bare "lease_status" is
// silently ignored by Buildium.
export async function fetchLeasesByStatus(
  statuses: Array<"Active" | "Past" | "Future">
): Promise<BuildiumLease[]> {
  const statusParam = statuses.join(",");
  return buildiumGetAllPages<BuildiumLease>(
    `/leases?leasestatuses=${encodeURIComponent(statusParam)}`,
    buildiumLeaseListSchema
  );
}

// FIXED 2026-07-05: this is now the SINGLE place "active leases" are
// fetched for every KPI on the dashboard (Avg Rent/Lease, lease-mix
// counts, the header's total lease count, occupancy, delinquency,
// renewals, tenancy, move-ins, evictions — every dashboardRoutes.ts route
// that used to call fetchLeasesByStatus(["Active"]) directly now calls
// this instead). CONFIRMED LIVE: 37 of Buildium's 240 LeaseStatus="Active"
// leases are stale/ghost records — CurrentTenants is empty and
// LeaseToDate is years in the past (e.g. lease 774300: LeaseFromDate
// 2015-11-12, LeaseToDate 2018-04-22, CurrentTenants: [], but LeaseStatus
// still says "Active"; Buildium's LeaseStatus field just never got
// flipped to "Past" for these). This filter was already applied for the
// rent-collection sync (src/api/syncRoutes.ts) but nothing else — e.g.
// Avg Rent/Lease averaged across all 240 including the 37 ghosts,
// producing $1,881.82 instead of the vendor's real ~$1,975. Filtering
// once here, at the fetch layer, means every caller gets the correct
// 203-lease set with no risk of a future call-site forgetting the filter.
export async function fetchActiveLeases(): Promise<BuildiumLease[]> {
  const leases = await fetchLeasesByStatus(["Active"]);
  return leases.filter((l) => l.CurrentTenants && l.CurrentTenants.length > 0);
}

// CORRECTED 2026-07-10, per Jason directly: the 2026-07-07 fix above
// (excluding Future leases with empty CurrentTenants as "ghosts," same
// pattern as Active) was wrong for Future specifically. CONFIRMED LIVE:
// 13 of 13 real Future-status leases on this account have empty
// CurrentTenants — 0 populated, no exceptions — including a lease Jason
// confirmed by hand is completely real (724 Carolina Avenue, signed lease
// starting 2026-08-01, tenant already entered in Buildium). A Future
// lease's tenant isn't "current" yet by definition (the tenancy hasn't
// started), so Buildium apparently never populates CurrentTenants for
// ANY Future lease, real or not — it's not a ghost signature the way it
// is for Active (where a real Active lease SHOULD have a current tenant,
// so an empty one really does mean stale/never-transitioned-to-Past).
// The 2026-07-07 "lands on exactly 203" vendor-match that justified this
// filter never actually depended on the Future-lease portion — that
// header count comes from fetchActiveLeases() (Active-status only, a
// separate function with its own still-valid ghost filter), not from
// here. Future leases are now included unconditionally, same as Past.
// Extracted 2026-07-28 so callers that specifically need the ghost record
// itself (see isNotGhostLease's own callers below) can apply this same
// rule without a second network round-trip through fetchLeasesByStatus.
export function isNotGhostLease(l: BuildiumLease): boolean {
  return l.LeaseStatus === "Past" || l.LeaseStatus === "Future" || (l.CurrentTenants !== null && l.CurrentTenants.length > 0);
}

export async function fetchAllLeases(): Promise<BuildiumLease[]> {
  const leases = await fetchLeasesByStatus(["Active", "Past", "Future"]);
  return leases.filter(isNotGhostLease);
}

// ADDED 2026-07-12 for the "every past and current tenant" Avg Tenancy
// rebuild, per Jason directly. Buildium's real /leases/tenants endpoint —
// CONFIRMED LIVE, one record per real tenant (931 on this account), each
// with their name and a Leases[] array of every lease they've ever been
// on. Deliberately NOT reusing fetchAllLeases() here: that function's
// ghost-Active filter (excluding Active leases with empty CurrentTenants
// and a stale LeaseToDate) is correct for occupancy-status purposes, but
// would silently DROP real historical tenants — CONFIRMED LIVE those 37
// "ghost" leases still carry a real, populated Tenants[] array. This
// endpoint's own per-lease Tenants[].Status ("Current"/"MovedOut"/
// "Future") is used instead of the lease-level LeaseStatus flag, which
// sidesteps that whole ghost-record problem entirely.
const buildiumTenantWithLeasesSchema = z.object({
  Id: z.number(),
  FirstName: z.string().nullable(),
  LastName: z.string().nullable(),
  Leases: z.array(buildiumLeaseSchema),
});
export type BuildiumTenantWithLeases = z.infer<typeof buildiumTenantWithLeasesSchema>;
const buildiumTenantWithLeasesListSchema = z.array(buildiumTenantWithLeasesSchema);

export async function fetchAllTenantsWithLeases(): Promise<BuildiumTenantWithLeases[]> {
  return buildiumGetAllPages<BuildiumTenantWithLeases>("/leases/tenants", buildiumTenantWithLeasesListSchema);
}

// ============================================================================
// Outstanding balances / delinquency
// ============================================================================
//
// Reuses the exact logic already fixed in late-rent-notices: the bulk
// /leases/outstandingbalances endpoint (NOT summing /leases/{id}/charges,
// which is the full historical charge ledger since lease inception and
// produced itemized totals 30-40x the real balance on a real lease — see
// late-rent-notices/src/buildium/client.ts lines ~220-235 for the original
// bug and fix). Per the endpoint's own description: "Leases with a zero or
// credit balance will not be returned" — a lease absent from the results
// means balance = 0, not an error.
const buildiumOutstandingBalanceByGlSchema = z.object({
  GlAccountId: z.number(),
  TotalBalance: z.number(),
});

const buildiumOutstandingBalanceSchema = z.object({
  LeaseId: z.number(),
  PropertyId: z.number(),
  TotalBalance: z.number(),
  EvictionPendingDate: z.string().nullable(),
  Balances: z.array(buildiumOutstandingBalanceByGlSchema).nullable(),
});

export interface LeaseBalanceByGl {
  glAccountId: number;
  balance: number;
}

export interface LeaseBalance {
  leaseId: string;
  propertyId: string;
  balance: number;
  evictionPendingDate: string | null;
  balancesByGl: LeaseBalanceByGl[];
}

export async function fetchOutstandingBalances(): Promise<LeaseBalance[]> {
  const rows = await buildiumGetAllPages<z.infer<typeof buildiumOutstandingBalanceSchema>>(
    "/leases/outstandingbalances?leasestatuses=Active",
    z.array(buildiumOutstandingBalanceSchema)
  );
  return rows.map((r) => ({
    leaseId: String(r.LeaseId),
    propertyId: String(r.PropertyId),
    balance: r.TotalBalance,
    evictionPendingDate: r.EvictionPendingDate,
    balancesByGl: (r.Balances ?? []).map((b) => ({ glAccountId: b.GlAccountId, balance: b.TotalBalance })),
  }));
}

// ============================================================================
// Applicants — Dashboard's "Apps Submitted" / "Apps Per Move-In" tiles.
// CONFIRMED LIVE 2026-07-06: these were previously hardcoded "Not connected
// yet" and mistagged as a LeadSimple (LS) source — this is real, live
// Buildium (BD) data. /applicants supports a real applicationstatuses
// filter (comma-separated, confirmed against the real API). "Apps
// Submitted" is a STRUCTURAL as-of-today count — how many submitted
// applications are currently awaiting a decision (status New or
// Undecided) — NOT a "submitted within the selected period" flow count. A
// "submitted this period" hypothesis was tested directly against the
// vendor's real number and came up far short (8 vs. 29); New+Undecided
// (27) matched closely, with the small gap explained by real-time drift
// between when the vendor's number was captured and when this was tested.
// "Apps Per Move-In" = this same pending count ÷ Move-Ins for the selected
// period (confirmed exact: 29 / 2 move-ins = 14.5, matching the vendor
// exactly).
const buildiumApplicantApplicationSchema = z.object({
  Id: z.number(),
  ApplicationStatus: z.string(),
  ApplicationSubmittedDateTime: z.string().nullable(),
});

// `PropertyId`, `UnitId`, `FirstName`, `LastName` — ADDED 2026-07-12 for
// the Apps Submitted drill-down: CONFIRMED LIVE present on the real
// /applicants response, previously silently dropped the same way several
// other fields on this account have been before their first real use.
// UnitId is nullable — an applicant can apply to a property generally
// before a specific unit is assigned. PropertyId is ALSO nullable —
// CONFIRMED LIVE once fetchAllApplicants (no status filter, a much wider
// population than fetchPendingApplicants' New/Undecided) surfaced 27 real
// applicant records with no property link at all (old/orphaned records),
// none of which happened to show up in the narrower pending-only set.
const buildiumApplicantSchema = z.object({
  Id: z.number(),
  PropertyId: z.number().nullable(),
  UnitId: z.number().nullable(),
  FirstName: z.string().nullable(),
  LastName: z.string().nullable(),
  Status: z.string(),
  Applications: z.array(buildiumApplicantApplicationSchema),
});

export type BuildiumApplicant = z.infer<typeof buildiumApplicantSchema>;

export async function fetchPendingApplicants(): Promise<BuildiumApplicant[]> {
  return buildiumGetAllPages<BuildiumApplicant>(
    "/applicants?applicationstatuses=New,Undecided",
    z.array(buildiumApplicantSchema)
  );
}

// ADDED 2026-07-12 for the Apps Per Vacancy drill-down — every applicant
// regardless of outcome (approved/denied/withdrawn all count as real
// interest in a property), unlike fetchPendingApplicants' New/Undecided
// filter above. Same endpoint, same schema, just no status filter.
export async function fetchAllApplicants(): Promise<BuildiumApplicant[]> {
  return buildiumGetAllPages<BuildiumApplicant>("/applicants", z.array(buildiumApplicantSchema));
}

const buildiumUnitListingSchema = z.object({
  ListingDate: z.string().nullable(),
  AvailableDate: z.string().nullable(),
});

export type BuildiumUnitListing = z.infer<typeof buildiumUnitListingSchema>;

// ADDED 2026-07-12 for the Apps Per Vacancy drill-down. CONFIRMED LIVE:
// GET /rentals/units/{id}/listing is a REAL endpoint (distinct 404 body —
// "No listing found with the unit id" — not the generic "unrecognized
// endpoint" error), but a listing record only exists while the unit is
// actively listed (13 of 401 units on this account right now); it's
// deleted, not archived, the moment the unit comes off the market. This
// returns null on that specific 404 rather than throwing — a unit simply
// not being listed right now is an expected, common state, not an error.
export async function fetchUnitListing(unitId: number): Promise<BuildiumUnitListing | null> {
  const env = loadEnv();
  const res = await fetch(`${env.BUILDIUM_BASE_URL}/rentals/units/${unitId}/listing`, { headers: buildiumHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new BuildiumApiError(`Buildium API error ${res.status} on /rentals/units/${unitId}/listing`, res.status, body);
  }
  const json = await res.json();
  const parsed = buildiumUnitListingSchema.safeParse(json);
  if (!parsed.success) {
    throw new BuildiumApiError(
      `Buildium API response for /rentals/units/${unitId}/listing did not match expected shape: ${parsed.error.message}`,
      res.status,
      JSON.stringify(json)
    );
  }
  return parsed.data;
}

// ============================================================================
// Properties / units / owners
// ============================================================================

const buildiumPropertyManagerSchema = z.object({
  Id: z.number(),
  FirstName: z.string().nullable(),
  LastName: z.string().nullable(),
  Email: z.string().email().nullable(),
});

const buildiumPropertySchema = z.object({
  Id: z.number(),
  Name: z.string().nullable(),
  IsActive: z.boolean().nullable(),
  RentalType: z.string().nullable(), // "Rental" | "Association" etc.
  NumberUnits: z.number().nullable(),
  Address: z.object({
    AddressLine1: z.string().nullable(),
    AddressLine2: z.string().nullable(),
    City: z.string().nullable(),
    State: z.string().nullable(),
    PostalCode: z.string().nullable(),
  }),
  RentalManager: buildiumPropertyManagerSchema.nullable(),
});

export type BuildiumProperty = z.infer<typeof buildiumPropertySchema>;

export async function fetchProperties(): Promise<BuildiumProperty[]> {
  return buildiumGetAllPages<BuildiumProperty>("/rentals", z.array(buildiumPropertySchema));
}

// CORRECTED LIVE 2026-07-03 against Jason's real Buildium account: the
// originally-guessed nested endpoint /rentals/{id}/units (per the OpenAPI
// spec's "RentalUnitMessage" docs) returns a 404 for EVERY property in this
// account, not just single-unit ones — confirmed by testing it against
// properties of every RentalSubType (SingleFamily, MultiFamily,
// CondoTownhome) and unit count. This was the root cause of
// /api/dashboard/occupancy failing outright. The REAL working endpoint is
// the bulk /rentals/units list (optionally filtered with a `propertyids`
// query param) — same data, one call instead of one call per property,
// which also fixes the N+1 pattern the old per-property loop had.
// IsUnitOccupied (confirmed present on the real response) is a direct,
// authoritative occupancy signal — better than deriving occupancy from
// active-lease counts, which the Dashboard's occupancy summary previously
// had to do without this field.
// IsUnitListed — ADDED 2026-07-12 for the Apps Per Vacancy drill-down:
// CONFIRMED LIVE real field on /rentals/units, true for exactly the units
// that have a live listing record at GET /rentals/units/{id}/listing (13
// of 401 on this account as of this writing).
const buildiumUnitSchema = z.object({
  Id: z.number(),
  PropertyId: z.number(),
  UnitNumber: z.string().nullable(),
  UnitSize: z.number().nullable(),
  MarketRent: z.number().nullable(),
  IsUnitOccupied: z.boolean(),
  IsUnitListed: z.boolean(),
});

export type BuildiumUnit = z.infer<typeof buildiumUnitSchema>;

// Fetches ALL units across the portfolio in one paginated bulk call,
// including inactive/former-client/non-residential properties' units.
// NOTE: for occupancy/portfolio-size reporting, use
// fetchActiveResidentialUnits() below instead — this raw function is kept
// for callers that genuinely need the unfiltered set (e.g. an admin/audit
// view), but using it directly for a "how many units do I manage" number
// is the exact mistake that produced 401 instead of the real ~230 (see
// that function's comment for the full story).
export async function fetchAllUnits(): Promise<BuildiumUnit[]> {
  return buildiumGetAllPages<BuildiumUnit>("/rentals/units", z.array(buildiumUnitSchema));
}

// CORRECTED LIVE 2026-07-03 against Jason's real Buildium account (second
// pass): fetchAllUnits() above returns 401 units — but Jason confirmed his
// real managed portfolio is ~230 units, matching CLAUDE.md's stated
// portfolio size. Investigated what's actually different between the ~230
// real units and the ~171 extra ones in this account's real data (not
// guessed from generic docs): properties carry IsActive (true/false) and
// RentalType ("Residential"/"Commercial"). In this account:
//   - IsActive: false properties account for 167 of the extra units —
//     former clients / inactive properties still sitting in Buildium's
//     data but no longer actually managed day to day.
//   - RentalType: "Commercial" accounts for 2 more units, outside what
//     Jason's residential property management business actually covers.
// Filtering to IsActive === true AND RentalType === "Residential" and
// cross-checking two different ways (summing property.NumberUnits vs.
// counting actual unit records) both independently land on 233 — right in
// the ~230 range Jason confirmed, not a coincidence. This is now the
// correct definition of "a unit that counts" for the Dashboard's
// occupancy/portfolio-size tiles.
export async function fetchActiveResidentialUnits(): Promise<BuildiumUnit[]> {
  const properties = await fetchProperties();
  const activeResidentialPropertyIds = new Set(
    properties.filter((p) => p.IsActive === true && p.RentalType === "Residential").map((p) => p.Id)
  );
  const allUnits = await fetchAllUnits();
  return allUnits.filter((u) => activeResidentialPropertyIds.has(u.PropertyId));
}

// Active properties of ANY RentalType (confirmed live: 201 total for this
// account — 200 Residential + 1 Commercial), for callers that need the
// full set of properties Jason actually manages today, not just the
// residential subset fetchActiveResidentialUnits() scopes to. Property
// Health (src/kpi/propertyHealth.ts) needs this broader set since
// Commercial is one of its real categories.
export async function fetchActiveProperties(): Promise<BuildiumProperty[]> {
  const properties = await fetchProperties();
  return properties.filter((p) => p.IsActive === true);
}

// ADDED 2026-07-05: Jason confirmed live he pays Buildium for 234 doors
// total and manages all of them, not just the 233 Residential ones —
// fetchActiveResidentialUnits() above excludes exactly one real active
// property ("6056 Providence Road", Buildium property id 668408,
// RentalType: "Commercial", 1 unit), which is why Total Units/Occupancy/
// Vacant previously showed 233 instead of the 234 Jason actually pays for.
// This is the same active-properties-of-any-RentalType set
// fetchActiveProperties() already returns (IsActive===true, no RentalType
// filter) — just resolved down to unit records the same way
// fetchActiveResidentialUnits() does. Scoped ONLY to Total Units/
// Occupancy/Vacant per Jason's explicit instruction — other metrics that
// use fetchActiveResidentialUnits() (Avg Rent/Lease, lease-mix, Revenue
// per Unit, Avg Days Vacant) were NOT switched here since commercial
// leases/rent structures may not be comparable to residential ones for
// those; each was left as-is pending Jason's confirmation.
export async function fetchActiveManagedUnits(): Promise<BuildiumUnit[]> {
  const properties = await fetchActiveProperties();
  const activePropertyIds = new Set(properties.map((p) => p.Id));
  const allUnits = await fetchAllUnits();
  return allUnits.filter((u) => activePropertyIds.has(u.PropertyId));
}

// Kept for any caller that genuinely needs one property's units without
// pulling the whole portfolio — uses the same confirmed-working bulk
// endpoint with a propertyids filter, NOT the broken nested path.
export async function fetchUnitsForProperty(propertyId: string): Promise<BuildiumUnit[]> {
  return buildiumGetAllPages<BuildiumUnit>(
    `/rentals/units?propertyids=${encodeURIComponent(propertyId)}`,
    z.array(buildiumUnitSchema)
  );
}

// CONFIRMED LIVE 2026-07-03 against Jason's real Buildium account: Email
// was originally validated with z.string().email(), which rejects the
// whole /rentals/owners list the moment ANY one record fails strict RFC
// email format — and one real owner record in this account has
// Email: "" (empty string, not null), which .email() rejects. This is
// real, valid data Buildium itself returned (an owner simply has no email
// on file, represented as "" rather than null) — the schema was too
// strict, not the data wrong. Relaxed to a plain nullable string so one
// owner's missing/malformed email can never take down the entire owners
// list; format validation, if ever needed, should happen at display time
// (e.g. "looks incomplete" UI hint) rather than at the API-ingestion layer
// where a rejection here means Jason can't see ANY owner's data at all.
// Exported (unlike most schemas in this file) specifically so a unit test
// can assert on its parsing behavior directly — the exact regression this
// schema exists to prevent (one owner's real-but-loosely-formatted Email
// value taking down the entire /rentals/owners list) needs a test that
// exercises the schema itself, not just the higher-level fetchOwners()
// function, which would require mocking global fetch to exercise the same
// thing less directly.
// EXTENDED 2026-07-03 for Doors Added (Occupancy & Doors section):
// ManagementAgreementStartDate, ManagementAgreementEndDate, and
// PropertyIds — CONFIRMED LIVE present on real /rentals/owners records for
// this account (previously silently dropped; zod ignores unrecognized
// object keys by default, so nothing broke, they just weren't captured).
// ManagementAgreementEndDate is captured here for completeness but is NOT
// used for Doors Lost yet — confirmed live only 12 of 383 owner records
// have any end date at all, most recent 2023, which does not match what
// Jason reports as real recent/ongoing churn (40+ doors lost last year, 2
// already this month per the coordinator). That field is not the real
// signal for door losses on this account; Doors Lost is intentionally not
// built against it (see src/kpi/churn.ts) pending further research into
// the actual real signal.
// `IsActive`, `PhoneNumbers`, `AlternateEmail` — ADDED 2026-07-12 for the
// Owners drill-down (see src/kpi/owners.ts): CONFIRMED LIVE present on
// real /rentals/owners records for this account, previously silently
// dropped the same way ManagementAgreementStartDate once was. `IsActive`
// is the real per-record status field — no need to separately compare
// against fetchActiveOwners()'s id set. PhoneNumbers defaults to [] (some
// real owner records have none) so a missing array can never crash
// parsing, same defensive pattern as PropertyIds below.
export const buildiumOwnerSchema = z.object({
  Id: z.number(),
  FirstName: z.string().nullable(),
  LastName: z.string().nullable(),
  IsCompany: z.boolean().nullable(),
  IsActive: z.boolean(),
  CompanyName: z.string().nullable(),
  Email: z.string().nullable(),
  AlternateEmail: z.string().nullable(),
  PhoneNumbers: z.array(z.object({ Number: z.string(), Type: z.string().nullable() })).default([]),
  ManagementAgreementStartDate: z.string().nullable(),
  ManagementAgreementEndDate: z.string().nullable(),
  PropertyIds: z.array(z.number()).nullable(),
});

export type BuildiumOwner = z.infer<typeof buildiumOwnerSchema>;

// Deliberately returns BOTH active and inactive owners (no status filter) —
// Doors Added/Lost and Net Doors (see dashboardRoutes.ts /api/dashboard/doors
// and /api/dashboard/net-doors/properties) need an owner's
// ManagementAgreementStartDate even after that owner has gone inactive, since
// "went inactive recently" is exactly how a lost door is detected. Do NOT
// swap this to fetchActiveOwners() for those routes.
export async function fetchOwners(): Promise<BuildiumOwner[]> {
  return buildiumGetAllPages<BuildiumOwner>("/rentals/owners", z.array(buildiumOwnerSchema));
}

// CONFIRMED LIVE 2026-07-05: Buildium's /rentals/owners defaults to
// returning both active AND inactive owners when no status param is given
// (383 total for this account = 251 Active + 132 Inactive). The Dashboard's
// Owners count tile should match the vendor's own dashboard, which shows
// Active owners only (251) — use this function for that tile, not
// fetchOwners().
export async function fetchActiveOwners(): Promise<BuildiumOwner[]> {
  return buildiumGetAllPages<BuildiumOwner>("/rentals/owners?status=Active", z.array(buildiumOwnerSchema));
}

// ============================================================================
// Chart of accounts (for classifying financial/GL data)
// ============================================================================
//
// Same flattening logic as late-rent-notices: top-level rows carry a
// SubAccounts array one level deep, which must be flattened for GLAccountId
// lookups to resolve real sub-account charges.
const buildiumGlAccountFlatSchema = z.object({
  Id: z.number(),
  Name: z.string(),
  Type: z.string(),
  SubType: z.string(),
  DefaultAccountName: z.string().nullable(),
  IsDefaultGLAccount: z.boolean(),
});

export type BuildiumGlAccount = z.infer<typeof buildiumGlAccountFlatSchema>;

const buildiumGlAccountSchema = buildiumGlAccountFlatSchema.extend({
  SubAccounts: z.array(buildiumGlAccountFlatSchema).nullable(),
});

export async function fetchGlAccountsById(): Promise<Map<number, BuildiumGlAccount>> {
  const rows = await buildiumGetAllPages<z.infer<typeof buildiumGlAccountSchema>>(
    "/glaccounts",
    z.array(buildiumGlAccountSchema)
  );
  const byId = new Map<number, BuildiumGlAccount>();
  for (const row of rows) {
    const { SubAccounts, ...flat } = row;
    byId.set(flat.Id, flat);
    for (const sub of SubAccounts ?? []) {
      byId.set(sub.Id, sub);
    }
  }
  return byId;
}

// ============================================================================
// General ledger (financial/GL history for Gross Income / Net Income /
// Revenue-per-Unit tiles)
// ============================================================================
//
// CONFIRMED LIVE 2026-07-05 against Jason's real Buildium account, replacing
// the old fetchGlEntries()'s guessed /glentries endpoint (which 404s — it
// does not exist). The real endpoint is GET /v1/generalledger, and it
// returns pre-summed per-account totals (BeginningBalance, TotalAmount, plus
// the raw Entries[] for that account/range), NOT raw double-entry journal
// rows — so no PostingType Debit/Credit sign-flipping is needed here;
// TotalAmount is already the correct signed net-change for the account over
// the range.
//
// Required query params (exact lowercase names, confirmed via real 200
// responses):
//   startdate, enddate       "YYYY-MM-DD". CONFIRMED the range between them
//                            must be <= 365 days per request (a wider range
//                            gets a real 422: "The time range must be less
//                            than or equal to 365 days.") — multi-year pulls
//                            need one call per <=365-day window, not one big
//                            call. See fetchMonthlyGlTotals below.
//   accountingbasis          'Cash' | 'Accrual'. CONFIRMED Cash is correct
//                            for this account: computed Gross Income for
//                            Jan-Jun 2026 (plus the Jul 1-5 partial month)
//                            matched Jason's real CEO View figures to the
//                            penny for all 7 months under Cash; Accrual does
//                            not match.
//   glaccountids             One or more GL account IDs. CONFIRMED Buildium
//                            accepts this as a REPEATED query param
//                            (glaccountids=3&glaccountids=4&...), not a
//                            single comma-separated value — tested both live
//                            and only the repeated form returns the expected
//                            per-account rows.
//   entitytype, entityid     Optional, but REQUIRED for a correct Gross/Net
//                            Income figure for this account. Without them,
//                            summing Income-type accounts returns Jason's
//                            entire trust-ledger activity (rent collected on
//                            behalf of every owner, ~6.45x too high) rather
//                            than Limehouse's own company revenue. Buildium
//                            tags each GL entry's AccountingEntity with an
//                            AccountingEntityType of either "Rental" (an
//                            individual owner's property/unit — pass-through,
//                            not Limehouse's income) or "Company" (Limehouse
//                            Property Management's own operating books).
//                            CONFIRMED the real Company entity ID for this
//                            account is 15695 (found by pulling real Jan 2026
//                            income entries and reading the AccountingEntity.Id
//                            off every entry tagged AccountingEntityType=
//                            "Company" — there is no dedicated /companies
//                            list endpoint, so this is the only way to
//                            discover it). Passing entitytype=Company&
//                            entityid=15695 reproduces Jason's real vendor
//                            Gross Income numbers exactly for every month
//                            checked (Jan-Jun 2026 plus partial Jul 2026,
//                            all matched to the penny).
const BUILDIUM_COMPANY_ENTITY_ID = 15695;

const buildiumGlAccountEntrySchema = z.object({
  Id: z.number(),
  Date: z.string(),
  Description: z.string().nullable(),
  Amount: z.number(),
  Balance: z.number(),
  TransactionType: z.string(),
});

const buildiumGeneralLedgerAccountSchema = z.object({
  GLAccountId: z.number(),
  GLAccountName: z.string(),
  BeginningBalance: z.number(),
  TotalAmount: z.number(),
  Entries: z.array(buildiumGlAccountEntrySchema),
});

export type BuildiumGeneralLedgerAccount = z.infer<typeof buildiumGeneralLedgerAccountSchema>;

// Buildium's own hard limit, confirmed via a real 422 ("The time range must
// be less than or equal to 365 days.") when a wider range was requested.
const MAX_GL_RANGE_DAYS = 365;

export function splitIntoMaxRangeWindows(startDate: string, endDate: string): Array<{ start: string; end: string }> {
  const windows: Array<{ start: string; end: string }> = [];
  let windowStart = new Date(`${startDate}T00:00:00Z`);
  const overallEnd = new Date(`${endDate}T00:00:00Z`);

  while (windowStart <= overallEnd) {
    const windowEnd = new Date(windowStart);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + MAX_GL_RANGE_DAYS - 1);
    const clampedEnd = windowEnd > overallEnd ? overallEnd : windowEnd;
    windows.push({
      start: windowStart.toISOString().slice(0, 10),
      end: clampedEnd.toISOString().slice(0, 10),
    });
    const nextStart = new Date(clampedEnd);
    nextStart.setUTCDate(nextStart.getUTCDate() + 1);
    windowStart = nextStart;
  }
  return windows;
}

// Fetches GL totals for a set of accounts over a date range, scoped to
// Limehouse's own Company entity (see BUILDIUM_COMPANY_ENTITY_ID above), for
// the given accounting basis. Splits the range into <=365-day windows
// automatically (Buildium's hard per-request limit) and merges the results
// per GL account (summing TotalAmount across windows, concatenating
// Entries) so callers never need to think about the windowing themselves.
//
// glAccountIds is capped at 50 per request (batched) — not yet confirmed as
// a real Buildium limit (this account's chart of accounts has 144 total
// entries, well under any batch size tested), but matches this project's
// existing conservative batching convention elsewhere and avoids an
// unnecessarily long query string.
const GL_ACCOUNT_BATCH_SIZE = 50;

export async function fetchGeneralLedgerTotals(
  glAccountIds: number[],
  startDate: string,
  endDate: string,
  accountingBasis: "Cash" | "Accrual" = "Cash"
): Promise<BuildiumGeneralLedgerAccount[]> {
  if (glAccountIds.length === 0) return [];

  const windows = splitIntoMaxRangeWindows(startDate, endDate);
  const merged = new Map<number, BuildiumGeneralLedgerAccount>();

  for (const window of windows) {
    for (let i = 0; i < glAccountIds.length; i += GL_ACCOUNT_BATCH_SIZE) {
      const batch = glAccountIds.slice(i, i + GL_ACCOUNT_BATCH_SIZE);
      const glParams = batch.map((id) => `glaccountids=${id}`).join("&");
      const path =
        `/generalledger?startdate=${encodeURIComponent(window.start)}` +
        `&enddate=${encodeURIComponent(window.end)}` +
        `&accountingbasis=${accountingBasis}` +
        `&entitytype=Company&entityid=${BUILDIUM_COMPANY_ENTITY_ID}` +
        `&${glParams}`;

      const rows = await buildiumGetAllPages<z.infer<typeof buildiumGeneralLedgerAccountSchema>>(
        path,
        z.array(buildiumGeneralLedgerAccountSchema)
      );

      for (const row of rows) {
        const existing = merged.get(row.GLAccountId);
        if (existing) {
          existing.TotalAmount += row.TotalAmount;
          existing.Entries.push(...row.Entries);
        } else {
          merged.set(row.GLAccountId, { ...row, Entries: [...row.Entries] });
        }
      }
    }
  }

  return [...merged.values()];
}

// Owner Onboarding Fee lookup — ADDED 2026-07-10, per Jason directly: the
// real signal for "this property has restarted active management" (he
// confirmed the fee being paid is literally what triggers marketing/photos
// to begin, not just a paperwork formality). CONFIRMED LIVE against a real
// example (724 Carolina Avenue): the fee is NOT its own GL account — it
// posts as a Check payment against whichever operating bank account,
// distinguishable only by its Description text ("724 Carolina Ave, Owner
// Onboarding Fee"). So this scans every GL account on the property's own
// (Rental entity) ledger for an entry whose Description mentions
// "Onboarding Fee", rather than filtering to one known account id.
//
// Scoped per-property (entitytype=Rental, not the Company-wide scope
// fetchGeneralLedgerTotals uses) — deliberately NOT run across the whole
// portfolio; only the small set of candidate terminated properties need
// this checked (see src/kpi/terminatedProperties.ts).
export async function fetchOnboardingFeeDate(propertyId: number, glAccountIds: number[], sinceDate: string, asOfDate: Date): Promise<string | null> {
  if (glAccountIds.length === 0) return null;
  const endDate = asOfDate.toISOString().slice(0, 10);
  const windows = splitIntoMaxRangeWindows(sinceDate, endDate);

  for (const window of windows) {
    for (let i = 0; i < glAccountIds.length; i += GL_ACCOUNT_BATCH_SIZE) {
      const batch = glAccountIds.slice(i, i + GL_ACCOUNT_BATCH_SIZE);
      const glParams = batch.map((id) => `glaccountids=${id}`).join("&");
      const path =
        `/generalledger?startdate=${encodeURIComponent(window.start)}` +
        `&enddate=${encodeURIComponent(window.end)}` +
        `&accountingbasis=Cash` +
        `&entitytype=Rental&entityid=${propertyId}` +
        `&${glParams}`;

      const rows = await buildiumGetAllPages<z.infer<typeof buildiumGeneralLedgerAccountSchema>>(
        path,
        z.array(buildiumGeneralLedgerAccountSchema)
      );

      for (const row of rows) {
        for (const entry of row.Entries) {
          if (entry.Description && /onboarding fee/i.test(entry.Description)) {
            return entry.Date;
          }
        }
      }
    }
  }
  return null;
}

// ============================================================================
// Lease payment transactions (for Rent Collection — 12 months chart: % of
// tenants who paid by the 3rd vs. by the 10th of the month, per month)
// ============================================================================
//
// RESEARCH NOTE, same unverified status as fetchGlEntries above: per
// Buildium's OpenAPI spec, /leases/{id}/transactions returns each ledger
// entry with TransactionType (e.g. "Payment", "Charge", "Credit"), a Date,
// and a TotalAmount. This client filters to TransactionType === "Payment"
// and treats the Date as the payment-received date for "paid by the Nth"
// bucketing. NOT yet confirmed live for this account — verify the exact
// TransactionType string values and Date semantics (posted date vs.
// received date, which may differ) once real Buildium access exists.
// late-rent-notices' client.ts (see its own comments) confirms /leases/{id}
// /transactions is a REAL, working endpoint distinct from /charges — this
// reuses that same confirmed endpoint, just requesting a different field
// (TransactionType) than the sibling project needed.
// Journal.Lines added 2026-07-04, per Oracle's real-data research into the
// Rent By 3rd/10th and Avg SD Withheld % fixes — confirmed present on
// every real transaction sampled (600+ across ~25 leases). Each line
// carries which GL account (e.g. "Rent Income" id 3, "Prepayments" id 18)
// a portion of the transaction posted against — this is the ONLY reliable
// way to tell "this dollar was rent" apart from "this dollar was a fee/
// deposit/credit" on a real Buildium ledger; TransactionType alone isn't
// enough (e.g. "Applied Prepayment" still needs its Journal.Lines to know
// which GL account received the money). Real confirmed TransactionType
// string values: "Payment", "Charge", "Applied Prepayment",
// "Applied Deposit", "Refund", "Reversed Payment", "Credit".
const buildiumJournalLineGlAccountSchema = z.object({
  Id: z.number(),
  Name: z.string(),
});

const buildiumJournalLineSchema = z.object({
  GLAccount: buildiumJournalLineGlAccountSchema,
  Amount: z.number(),
});

const buildiumJournalSchema = z.object({
  Memo: z.string().nullable(),
  Lines: z.array(buildiumJournalLineSchema),
});

const buildiumLeaseTransactionSchema = z.object({
  Id: z.number(),
  LeaseId: z.number(),
  Date: z.string(),
  TransactionType: z.string(), // "Payment" | "Charge" | "Applied Prepayment" | "Applied Deposit" | "Refund" | "Reversed Payment" | "Credit"
  TotalAmount: z.number(),
  Journal: buildiumJournalSchema.optional(), // optional defensively; confirmed present on every real transaction sampled, but not worth a hard crash if a future/edge-case transaction type omits it
});

export type BuildiumLeaseTransaction = z.infer<typeof buildiumLeaseTransactionSchema>;

export async function fetchLeaseTransactions(buildiumLeaseId: string): Promise<BuildiumLeaseTransaction[]> {
  return buildiumGetAllPages<BuildiumLeaseTransaction>(
    `/leases/${encodeURIComponent(buildiumLeaseId)}/transactions`,
    z.array(buildiumLeaseTransactionSchema)
  );
}

// CONFIRMED LIVE 2026-07-07, per Jason: the vendor's Renewal Rate tile is
// keyed off each lease's Rent recurring-charge schedule (visible in
// Buildium's own UI under Tenants > Financials > Rent, or a property's
// Recurring Transactions), NOT LeaseFromDate/LastUpdatedDateTime — verified
// against 2 real leases where the vendor's shown "renewed" date matched
// this endpoint's Rent-line FirstOccurrenceDate exactly (one lease had TWO
// Rent entries, both IsExpired:false — the vendor used the one with the
// LATEST FirstOccurrenceDate, i.e. the current/most-recently-scheduled rent
// period, not the oldest). GLAccountId 3 = Rent Income, same constant
// rentCollection.ts already uses to isolate real rent charges from fees.
const buildiumRecurringTransactionLineSchema = z.object({
  GLAccountId: z.number(),
  Amount: z.number(),
});

const buildiumLeaseRecurringTransactionSchema = z.object({
  Id: z.number(),
  TransactionType: z.string(),
  IsExpired: z.boolean(),
  Lines: z.array(buildiumRecurringTransactionLineSchema),
  Amount: z.number(),
  Memo: z.string().nullable(),
  FirstOccurrenceDate: z.string(),
  NextOccurrenceDate: z.string().nullable(),
  Frequency: z.string(),
});

export type BuildiumLeaseRecurringTransaction = z.infer<typeof buildiumLeaseRecurringTransactionSchema>;

export async function fetchLeaseRecurringTransactions(buildiumLeaseId: string): Promise<BuildiumLeaseRecurringTransaction[]> {
  return buildiumGetAllPages<BuildiumLeaseRecurringTransaction>(
    `/leases/${encodeURIComponent(buildiumLeaseId)}/recurringtransactions`,
    z.array(buildiumLeaseRecurringTransactionSchema)
  );
}

// ============================================================================
// Vendors — for Bookkeeper's Vendor Compliance / 1099 Compliance KPIs.
// CONFIRMED LIVE 2026-07-05: Category.Name for maintenance/trade vendors
// really does start with "Contractor" (e.g. "Contractors - Plumbing",
// "Contractor - RE Contractor (1099 Work)") — 55 real active vendors match
// this scope out of 499 total. Buildium's own ?statuses=Active query param
// was NOT used here per Jason's own findings that it's unreliable — every
// vendor is fetched and re-filtered on its own IsActive flag instead.
const buildiumVendorCategorySchema = z.object({
  Id: z.number(),
  Name: z.string().nullable(),
});

const buildiumVendorInsuranceSchema = z.object({
  Provider: z.string().nullable(),
  PolicyNumber: z.string().nullable(),
  ExpirationDate: z.string().nullable(),
});

const buildiumVendorTaxInformationSchema = z.object({
  TaxPayerIdType: z.string().nullable(),
  TaxPayerId: z.string().nullable(),
  IncludeIn1099: z.boolean(),
});

// FirstName/LastName — ADDED 2026-07-26, per Jason directly: CONFIRMED LIVE
// against real vendor records, Buildium only populates CompanyName for
// company vendors (IsCompany: true) — an individual vendor (IsCompany:
// false, e.g. a one-off 1099 referral-fee recipient) has CompanyName as an
// empty string and their real name under FirstName/LastName instead. Every
// display of a vendor's name needs to fall back to these, or individual
// vendors show up blank.
const buildiumVendorSchema = z.object({
  Id: z.number(),
  IsActive: z.boolean(),
  CompanyName: z.string().nullable(),
  FirstName: z.string().nullable(),
  LastName: z.string().nullable(),
  Category: buildiumVendorCategorySchema,
  VendorInsurance: buildiumVendorInsuranceSchema,
  TaxInformation: buildiumVendorTaxInformationSchema,
});

export type BuildiumVendor = z.infer<typeof buildiumVendorSchema>;

export async function fetchVendors(): Promise<BuildiumVendor[]> {
  return buildiumGetAllPages<BuildiumVendor>("/vendors", z.array(buildiumVendorSchema));
}

// ============================================================================
// Bank accounts / reconciliations — for Bookkeeper's Reconciliation Accuracy
// KPI. CONFIRMED LIVE: Balance and IsActive are top-level fields on the
// bank account itself (not nested under GLAccount). Some accounts (credit
// cards linked via an external feed) return a 409 from the reconciliations
// endpoint ("Cannot retrieve reconciliation(s) for an externally linked
// bank account") — this is a real, permanent state for that account type,
// not a transient error, so callers must treat it as "not reconcilable
// here" rather than retrying or crashing.
const buildiumBankAccountSchema = z.object({
  Id: z.number(),
  Name: z.string().nullable(),
  IsActive: z.boolean(),
  Balance: z.number(),
});

export type BuildiumBankAccount = z.infer<typeof buildiumBankAccountSchema>;

export async function fetchBankAccounts(): Promise<BuildiumBankAccount[]> {
  return buildiumGetAllPages<BuildiumBankAccount>("/bankaccounts", z.array(buildiumBankAccountSchema));
}

const buildiumReconciliationSchema = z.object({
  Id: z.number(),
  StatementEndingDate: z.string(),
  IsFinished: z.boolean(),
});

export type BuildiumReconciliation = z.infer<typeof buildiumReconciliationSchema>;

export interface BankAccountReconciliationsResult {
  reconcilable: boolean;
  reconciliations: BuildiumReconciliation[];
}

export async function fetchBankAccountReconciliations(bankAccountId: number): Promise<BankAccountReconciliationsResult> {
  try {
    const reconciliations = await buildiumGetAllPages<BuildiumReconciliation>(
      `/bankaccounts/${bankAccountId}/reconciliations`,
      z.array(buildiumReconciliationSchema)
    );
    return { reconcilable: true, reconciliations };
  } catch (err) {
    if (err instanceof BuildiumApiError && err.status === 409) {
      return { reconcilable: false, reconciliations: [] };
    }
    throw err;
  }
}
