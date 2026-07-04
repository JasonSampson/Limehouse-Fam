import { z } from "zod";
import { loadEnv } from "../config/env.js";

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

async function buildiumGet<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, any>): Promise<T> {
  const env = loadEnv();
  const res = await fetch(`${env.BUILDIUM_BASE_URL}${path}`, { headers: buildiumHeaders() });
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
// RESEARCH NOTE (unverified, same discipline as fetchGlEntries below): per
// Buildium's OpenAPI spec ("LeaseMessage"), a lease carries a CurrentRent
// object (with an Amount field, the active rent charge amount) and a
// SecurityDeposit object (with an Amount field, the deposit amount on
// file). These two fields back the Dashboard Financials tab's "Avg
// Rent/Lease" and "Avg SD Withheld" tiles. NOT yet confirmed against a live
// response for this account — no Buildium credentials exist for this
// project yet (see project brief). If the real response shapes these
// differently (e.g. a flat RentAmount instead of nested CurrentRent.Amount),
// this schema will need a live-verified correction once Jason provisions
// the fresh Buildium key.
const buildiumRentSchema = z.object({ Amount: z.number().nullable() }).nullable();
const buildiumSecurityDepositSchema = z.object({ Amount: z.number().nullable() }).nullable();

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
  CurrentRent: buildiumRentSchema.optional(),
  SecurityDeposit: buildiumSecurityDepositSchema.optional(),
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

export async function fetchActiveLeases(): Promise<BuildiumLease[]> {
  return fetchLeasesByStatus(["Active"]);
}

export async function fetchAllLeases(): Promise<BuildiumLease[]> {
  return fetchLeasesByStatus(["Active", "Past", "Future"]);
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

// CONFIRMED via OpenAPI spec "RentalUnitMessage": units are a nested
// resource under a rental property (/rentals/{id}/units), not a top-level
// /units list endpoint. UnitStatus (Occupied/Vacant/etc.) is what backs the
// occupancy/vacancy tiles.
const buildiumUnitSchema = z.object({
  Id: z.number(),
  PropertyId: z.number(),
  UnitNumber: z.string().nullable(),
  UnitSize: z.number().nullable(),
  MarketRent: z.number().nullable(),
});

export type BuildiumUnit = z.infer<typeof buildiumUnitSchema>;

export async function fetchUnitsForProperty(propertyId: string): Promise<BuildiumUnit[]> {
  return buildiumGetAllPages<BuildiumUnit>(
    `/rentals/${encodeURIComponent(propertyId)}/units`,
    z.array(buildiumUnitSchema)
  );
}

const buildiumOwnerSchema = z.object({
  Id: z.number(),
  FirstName: z.string().nullable(),
  LastName: z.string().nullable(),
  IsCompany: z.boolean().nullable(),
  CompanyName: z.string().nullable(),
  Email: z.string().email().nullable(),
});

export type BuildiumOwner = z.infer<typeof buildiumOwnerSchema>;

export async function fetchOwners(): Promise<BuildiumOwner[]> {
  return buildiumGetAllPages<BuildiumOwner>("/rentals/owners", z.array(buildiumOwnerSchema));
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
// General ledger transactions (financial/GL history for Gross Income / Net
// Income / Revenue-per-Unit tiles)
// ============================================================================
//
// RESEARCH NOTE (verify against real account before trusting the date range
// in production): Buildium's OpenAPI spec exposes /v1/glentries (GL journal
// entries — the raw double-entry rows, each with a JournalId, a Date, a
// Memo, and Lines[] carrying GlAccountId + Amount + PostingType Debit/Credit)
// and /v1/generalledger/accountbalances (a summarized net-change/balance
// endpoint per GL account over a date range). There is NO endpoint that
// directly returns "Gross Income" / "Net Income" as named figures — those
// are derived by summing glentries (or accountbalances) for GL accounts
// classified Type=Income or Type=Expense via fetchGlAccountsById above,
// the same classify-then-sum pattern late-rent-notices already uses for
// itemized charges. This function fetches raw journal entries for a date
// range; monthly Income/Expense rollups are computed in
// src/kpi/financialSummary.ts by classifying each line's GlAccountId and
// bucketing by the entry's month.
//
// Buildium's actual data retention for GL history is account-specific (it
// depends on how long Limehouse has used Buildium and whether older data
// was ever migrated in) — this client does NOT assume data exists back to
// 2018. Callers must inspect the real earliest entry date returned and
// report that plainly rather than assume the full requested range came
// back. See src/kpi/financialSummary.ts for where that check happens.
const buildiumGlEntryLineSchema = z.object({
  GlAccountId: z.number(),
  Amount: z.number(),
  PostingType: z.enum(["Debit", "Credit"]),
});

const buildiumGlEntrySchema = z.object({
  Id: z.number(),
  Date: z.string(),
  Memo: z.string().nullable(),
  Lines: z.array(buildiumGlEntryLineSchema),
});

export type BuildiumGlEntry = z.infer<typeof buildiumGlEntrySchema>;

// fromDate/toDate are "YYYY-MM-DD". Buildium's /glentries endpoint accepts
// FromDate/ToDate query params per the OpenAPI spec (confirmed live pattern
// with other Buildium endpoints' PascalCase-but-lowercase-in-querystring
// convention — verify actual param casing against a real 200 response
// before relying on this in production; Buildium's query params are
// case-insensitive in practice but this is noted here as unverified for
// THIS specific endpoint until a live call has been made against Jason's
// real account).
export async function fetchGlEntries(fromDate: string, toDate: string): Promise<BuildiumGlEntry[]> {
  return buildiumGetAllPages<BuildiumGlEntry>(
    `/glentries?fromdate=${encodeURIComponent(fromDate)}&todate=${encodeURIComponent(toDate)}`,
    z.array(buildiumGlEntrySchema)
  );
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
const buildiumLeaseTransactionSchema = z.object({
  Id: z.number(),
  LeaseId: z.number(),
  Date: z.string(),
  TransactionType: z.string(), // "Payment" | "Charge" | "Credit" | ... — filter to "Payment" for collection tracking
  TotalAmount: z.number(),
});

export type BuildiumLeaseTransaction = z.infer<typeof buildiumLeaseTransactionSchema>;

export async function fetchLeaseTransactions(buildiumLeaseId: string): Promise<BuildiumLeaseTransaction[]> {
  return buildiumGetAllPages<BuildiumLeaseTransaction>(
    `/leases/${encodeURIComponent(buildiumLeaseId)}/transactions`,
    z.array(buildiumLeaseTransactionSchema)
  );
}
