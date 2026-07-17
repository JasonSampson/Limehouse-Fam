import { z } from "zod";
import { loadEnv } from "../config/env.js";

// CONFIRMED against Buildium's actual OpenAPI spec (provided by Jason) and
// live calls against his real account — no longer an assumption. Auth is
// x-buildium-client-id / x-buildium-client-secret headers.
function buildiumHeaders(): Record<string, string> {
  const env = loadEnv();
  return {
    "x-buildium-client-id": env.BUILDIUM_CLIENT_ID,
    "x-buildium-client-secret": env.BUILDIUM_CLIENT_SECRET,
    Accept: "application/json",
  };
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

export class BuildiumApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
    this.name = "BuildiumApiError";
  }
}

// CONFIRMED via OpenAPI spec "TenantMessage" / "LeaseMessage". Tenant email
// lives on CurrentTenants (the people actually living there now), NOT on
// Tenants (which is "every tenant ever associated with the lease" and only
// carries Id/Status/MoveInDate — no email at all).
const buildiumTenantSchema = z.object({
  Id: z.number(),
  FirstName: z.string().nullable(),
  LastName: z.string().nullable(),
  Email: z.string().email().nullable(),
});

const buildiumLeaseSchema = z.object({
  Id: z.number(),
  PropertyId: z.number(),
  UnitId: z.number(),
  UnitNumber: z.string().nullable(),
  LeaseStatus: z.enum(["Active", "Past", "Future"]),
  IsEvictionPending: z.boolean(),
  PaymentDueDay: z.number().int().min(1).max(31),
  CurrentTenants: z.array(buildiumTenantSchema).nullable(),
});

export type BuildiumLease = z.infer<typeof buildiumLeaseSchema>;

const buildiumLeaseListSchema = z.array(buildiumLeaseSchema);

// CONFIRMED endpoint: /v1/leases (not /v1/rentalproperties as originally
// guessed). leasestatuses is a real, working array query param (verified
// live — a plain "lease_status" param is silently ignored by Buildium and
// returns unfiltered results, which is why this had to be checked against
// real data, not just docs).
export async function fetchActiveLeases(): Promise<BuildiumLease[]> {
  return buildiumGet<BuildiumLease[]>(
    "/leases?leasestatuses=Active&limit=1000",
    buildiumLeaseListSchema
  );
}

// CONFIRMED via OpenAPI spec: there is NO dedicated single-lease ledger
// endpoint (/leases/{id}/ledger returns 404, verified live). The correct
// endpoint is the bulk /leases/outstandingbalances, which also accepts a
// leaseids filter — so the SAME function and schema serve both the daily
// bulk check and the single-lease stale-draft recheck at send time. Per the
// endpoint's own description: "Leases with a zero or credit balance will
// not be returned" — a lease with nothing owed simply won't appear in the
// results, which callers must treat as balance = 0, not an error.
//
// CONFIRMED LIVE 2026-07-02: each row also carries a `Balances` array —
// TotalBalance broken down PER GL ACCOUNT (already netted against payments
// by Buildium, not a raw charge sum). Verified against all 57 real active
// leases with a nonzero balance: sum(Balances[].TotalBalance) === the row's
// own TotalBalance in every single case (0 mismatches). This is the
// authoritative "what's actually currently owed, by category" breakdown —
// see noticeLineItems.ts, which classifies THIS array instead of summing
// /leases/{id}/charges (that endpoint returns the full lifetime charge
// ledger since lease inception, not what's currently outstanding, and
// summing it produced itemized totals 30-40x the real balance on a real
// lease — GL 2317038, $110,044.67 itemized vs $3,115.95 actually owed).
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
  balance: number;
  evictionPendingDate: string | null;
  balancesByGl: LeaseBalanceByGl[];
}

export async function fetchOutstandingBalances(): Promise<LeaseBalance[]> {
  const rows = await buildiumGet<z.infer<typeof buildiumOutstandingBalanceSchema>[]>(
    "/leases/outstandingbalances?leasestatuses=Active&limit=1000",
    z.array(buildiumOutstandingBalanceSchema)
  );
  return rows.map((r) => ({
    leaseId: String(r.LeaseId),
    balance: r.TotalBalance,
    evictionPendingDate: r.EvictionPendingDate,
    balancesByGl: (r.Balances ?? []).map((b) => ({ glAccountId: b.GlAccountId, balance: b.TotalBalance })),
  }));
}

// Single-lease balance for the stale-draft recheck at send time. A lease
// absent from the response means zero/credit balance — not an error.
export async function fetchLeaseOutstandingBalance(buildiumLeaseId: string): Promise<LeaseBalance> {
  const rows = await buildiumGet<z.infer<typeof buildiumOutstandingBalanceSchema>[]>(
    `/leases/outstandingbalances?leaseids=${encodeURIComponent(buildiumLeaseId)}&limit=1`,
    z.array(buildiumOutstandingBalanceSchema)
  );
  if (rows.length === 0) {
    return { leaseId: buildiumLeaseId, balance: 0, evictionPendingDate: null, balancesByGl: [] };
  }
  const r = rows[0];
  return {
    leaseId: String(r.LeaseId),
    balance: r.TotalBalance,
    evictionPendingDate: r.EvictionPendingDate,
    balancesByGl: (r.Balances ?? []).map((b) => ({ glAccountId: b.GlAccountId, balance: b.TotalBalance })),
  };
}

// CONFIRMED via OpenAPI spec "RentalMessage": RentalManager is an object
// EMBEDDED directly on the rental property response — there is no separate
// staff-assignments endpoint (the earlier client.ts guessed one that
// doesn't exist). This eliminates an entire API call: properties and their
// assigned PM come back together in one response.
const buildiumPropertyManagerSchema = z.object({
  Id: z.number(),
  FirstName: z.string().nullable(),
  LastName: z.string().nullable(),
  Email: z.string().email().nullable(),
});

// IsActive: CONFIRMED LIVE (2026-07-17) this is a real field on every
// /v1/rentals row — true means "currently under management," false means
// sold/inactive/historical (includes every stale "OLD"-suffixed duplicate
// property Jason has flagged, e.g. "4314 Dunning Road OLD"). Captured here
// (not just used as a query filter) so the schema stays honest about what
// Buildium actually returns and so fetchProperties can defensively re-check
// it even though the query already filters server-side.
const buildiumPropertySchema = z.object({
  Id: z.number(),
  Name: z.string().nullable(),
  IsActive: z.boolean(),
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

// CONFIRMED endpoint: /v1/rentals (not /v1/rentalproperties).
//
// CONFIRMED LIVE (2026-07-17): /rentals returns EVERY property ever entered
// in Buildium, active or not, unless filtered — 323 total on Jason's real
// account, of which only 197 are IsActive:true. The obvious-looking
// `isactive=true` / `IsActive=true` query params are silently ignored by
// Buildium (same "param name doesn't do what you'd guess" trap as
// leasestatuses elsewhere in this file) — they return unfiltered results.
// The param that actually works is `status=Active`, verified to return
// exactly the 197 IsActive:true rows and nothing else. Those 197 active
// properties sum to 230 units (NumberUnits) — an exact match to Jason's
// documented ~230 units under management, confirming this is the right
// filter. The other 126 properties (401 - 230 = 171... note: properties vs
// units aren't 1:1, unit total isn't meaningful for inactive ones) include
// sold properties, historical duplicates, and every "OLD"-suffixed stale
// record Jason flagged. IsActive is also captured in the schema above as a
// defensive re-check, not relied on as the only filter, since the server-
// side param is strictly cheaper (no wasted rows over the wire).
export async function fetchProperties(): Promise<BuildiumProperty[]> {
  return buildiumGet<BuildiumProperty[]>(
    "/rentals?status=Active&limit=1000",
    z.array(buildiumPropertySchema)
  );
}

// Unfiltered — every property Buildium has ever seen (all 323, active and
// inactive), unlike fetchProperties() above which is server-side filtered
// to status=Active only. NOT used by the regular sync (syncBuildiumData
// must stay on the cheap, already-filtered call) — this exists only for
// the one-time data-fix script (scripts/markStalePropertiesInactive.ts)
// that needs to re-verify, live, which of the ALREADY-locally-synced stale
// properties Buildium's IsActive field actually says are inactive, rather
// than trusting a point-in-time count taken earlier.
export async function fetchAllPropertiesIncludingInactive(): Promise<BuildiumProperty[]> {
  return buildiumGet<BuildiumProperty[]>("/rentals?limit=1000", z.array(buildiumPropertySchema));
}

// CONFIRMED live against a real Buildium account (2026-07-02, read-only):
// /leases/{id}/charges returns ONLY Id/Date/TotalAmount/Memo/BillId/Lines,
// where each Lines entry is just { Amount, GLAccountId } — a bare numeric
// account id, with NO embedded GLAccount.Name/Type/SubType. This is
// different from /leases/{id}/transactions, which DOES embed the full
// GLAccount object on each journal line. Neo's migration comment assumed
// charge lines would carry GLAccount.Type/SubType/Name directly; they do
// not. Classification requires a separate /glaccounts lookup (see
// fetchGlAccountsById below) to resolve each GLAccountId first.
//
// Also confirmed live: charge amounts are always positive in practice (no
// negative/zero-amount lines observed across a real lease's full charge
// history), and every observed charge had exactly one Lines entry — but
// neither is guaranteed by the schema, so both are still validated/handled
// defensively by callers rather than assumed.
const buildiumChargeLineSchema = z.object({
  Amount: z.number(),
  GLAccountId: z.number(),
});

const buildiumLeaseChargeSchema = z.object({
  Id: z.number(),
  Date: z.string(),
  TotalAmount: z.number(),
  Memo: z.string().nullable(),
  BillId: z.number().nullable(),
  Lines: z.array(buildiumChargeLineSchema),
});

export type BuildiumLeaseCharge = z.infer<typeof buildiumLeaseChargeSchema>;

// Fetches every charge ever posted to a lease (not payments/credits —
// /leases/{id}/transactions covers the full ledger, this endpoint is charges
// only) since lease inception.
//
// DO NOT use this to compute what a tenant currently owes: it is the FULL
// HISTORICAL charge ledger with no date filter and no way to distinguish
// paid from unpaid charges. Summing it produces a number with no
// relationship to the real current balance — confirmed live on real lease
// 2317038, where summing every charge since 2023 gave $110,044.67 against a
// real outstanding balance of $3,115.95 (35x too high). notice_line_items'
// itemized breakdown is now computed from fetchOutstandingBalances'/
// fetchLeaseOutstandingBalance's `balancesByGl` field instead (see
// noticeLineItems.ts), which Buildium itself already nets against payments
// down to what's actually currently owed, broken down per GL account.
// This function is kept for any future need to look at charge HISTORY
// (e.g. an audit view), not for computing a currently-owed itemization.
export async function fetchLeaseCharges(buildiumLeaseId: string): Promise<BuildiumLeaseCharge[]> {
  return buildiumGet<BuildiumLeaseCharge[]>(
    `/leases/${encodeURIComponent(buildiumLeaseId)}/charges?limit=1000`,
    z.array(buildiumLeaseChargeSchema)
  );
}

// CONFIRMED live (2026-07-02): /glaccounts?limit=1000 returns 121 TOP-LEVEL
// rows, not the full chart of accounts — real sub-accounts (Buildium's
// "sub-GL-account" feature, e.g. "Lease Change Fee" nested under "Mgmnt Fee
// Income - LH Plan") are embedded on their parent's SubAccounts array, NOT
// returned as their own flat row. Confirmed live that Limehouse tenants are
// actually charged directly to sub-account GL ids (e.g. GL 857392 "Lease
// Change Fee" appeared on a real lease's charge history) — so a lookup that
// only indexes the 121 top-level rows silently fails to resolve those
// charges (GLAccountId not in the map), which upstream
// fetchAndClassifyLeaseCharges treats as "unknown account" and blocks the
// whole notice. fetchGlAccountsById flattens one level of SubAccounts so
// every real charge-line GLAccountId — parent or sub-account — resolves.
// True total observed: 144 accounts (121 top-level + 23 nested one level
// deep; Buildium's response does not nest deeper than one level, confirmed
// live — no sub-account in the real response carried its own non-empty
// SubAccounts, so this schema deliberately does not model further nesting).
const buildiumGlAccountFlatSchema = z.object({
  Id: z.number(),
  Name: z.string(),
  Type: z.string(),
  SubType: z.string(),
  DefaultAccountName: z.string().nullable(),
  IsDefaultGLAccount: z.boolean(),
});

export type BuildiumGlAccount = z.infer<typeof buildiumGlAccountFlatSchema>;

// Top-level rows additionally carry a SubAccounts array (one level deep,
// same flat shape) that fetchGlAccountsById below flattens into the same
// Map as their parent.
const buildiumGlAccountSchema = buildiumGlAccountFlatSchema.extend({
  SubAccounts: z.array(buildiumGlAccountFlatSchema).nullable(),
});

const buildiumGlAccountListSchema = z.array(buildiumGlAccountSchema);

// Fetches the FULL chart of accounts — top-level accounts plus one level of
// nested sub-accounts, flattened — then returns a Map for O(1) lookup by
// GLAccountId. There is no bulk "/glaccounts?ids=..." filter confirmed live,
// and the chart of accounts is small (144 rows for Limehouse, including
// sub-accounts) and changes rarely, so one full fetch per call site is
// simple and cheap — no caching layer added here; callers that need many
// lookups in one job run (the classification flow) should call this once
// and reuse the returned Map.
export async function fetchGlAccountsById(): Promise<Map<number, BuildiumGlAccount>> {
  const rows = await buildiumGet<z.infer<typeof buildiumGlAccountSchema>[]>(
    "/glaccounts?limit=1000",
    buildiumGlAccountListSchema
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
