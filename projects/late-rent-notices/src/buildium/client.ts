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
const buildiumOutstandingBalanceSchema = z.object({
  LeaseId: z.number(),
  PropertyId: z.number(),
  TotalBalance: z.number(),
  EvictionPendingDate: z.string().nullable(),
});

export interface LeaseBalance {
  leaseId: string;
  balance: number;
  evictionPendingDate: string | null;
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
    return { leaseId: buildiumLeaseId, balance: 0, evictionPendingDate: null };
  }
  const r = rows[0];
  return { leaseId: String(r.LeaseId), balance: r.TotalBalance, evictionPendingDate: r.EvictionPendingDate };
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

const buildiumPropertySchema = z.object({
  Id: z.number(),
  Name: z.string().nullable(),
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
export async function fetchProperties(): Promise<BuildiumProperty[]> {
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

// Fetches every charge (not payments/credits — /leases/{id}/transactions
// covers the full ledger, this endpoint is charges only) posted to a lease.
// Used both at draft time and again at send time to snapshot the itemized
// breakdown (see notice_line_items / migration 0038).
export async function fetchLeaseCharges(buildiumLeaseId: string): Promise<BuildiumLeaseCharge[]> {
  return buildiumGet<BuildiumLeaseCharge[]>(
    `/leases/${encodeURIComponent(buildiumLeaseId)}/charges?limit=1000`,
    z.array(buildiumLeaseChargeSchema)
  );
}

// CONFIRMED live: /glaccounts?limit=1000 returns Limehouse's full real chart
// of accounts (121 accounts observed). DefaultAccountName + IsDefaultGLAccount
// is the field pair the classifier actually relies on (see
// glClassification.ts for why SubType and Name are NOT safe classification
// keys) — both are included here even though only those two plus Type/Name
// drive today's classifier, so a future reviewer has the same context
// Buildium gave us, not just the bucket decision.
const buildiumGlAccountSchema = z.object({
  Id: z.number(),
  Name: z.string(),
  Type: z.string(),
  SubType: z.string(),
  DefaultAccountName: z.string().nullable(),
  IsDefaultGLAccount: z.boolean(),
});

export type BuildiumGlAccount = z.infer<typeof buildiumGlAccountSchema>;

const buildiumGlAccountListSchema = z.array(buildiumGlAccountSchema);

// Fetches the FULL chart of accounts, then returns a Map for O(1) lookup by
// GLAccountId. There is no bulk "/glaccounts?ids=..." filter confirmed live,
// and the chart of accounts is small (~121 rows for Limehouse) and changes
// rarely, so one full fetch per call site is simple and cheap — no caching
// layer added here; callers that need many lookups in one job run (the
// classification flow) should call this once and reuse the returned Map.
export async function fetchGlAccountsById(): Promise<Map<number, BuildiumGlAccount>> {
  const rows = await buildiumGet<BuildiumGlAccount[]>("/glaccounts?limit=1000", buildiumGlAccountListSchema);
  return new Map(rows.map((row) => [row.Id, row]));
}
