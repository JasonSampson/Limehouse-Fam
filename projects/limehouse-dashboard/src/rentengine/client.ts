import { z } from "zod";
import { loadEnv, isRentEngineConnected } from "../config/env.js";
import { logWarn } from "../lib/logger.js";
import { rentEngineLimiter } from "../lib/globalRequestLimiter.js";

// CONFIRMED LIVE 2026-07-03 against Jason's real RentEngine account
// (account_id 29a7815c-08a9-45df-a13a-f75376c95770). Every endpoint, field
// name, and response shape below was verified with a real API call before
// being written here — nothing in this file is a generic-docs guess
// anymore. Key findings that differ from the original placeholder version:
//
//   - Real base URL is https://app.rentengine.io/api/public/v1 (the old
//     api.rentengine.com/v1 was never real — fixed in .env/.env.example).
//   - /prospects and /units both return a BARE JSON ARRAY, not an
//     envelope. /calls and /messages return {data: [...], page: {...}}
//     instead — the two endpoint families do not share a response shape.
//   - /prospects pages via created_after/created_before (ISO 8601), max
//     limit 100, NO offset/page param (both 400). There is no "has more"
//     flag on this endpoint — same "fewer rows than page size = last page"
//     signal Buildium's client already relies on.
//   - Real `source` values are messier than any fixed enum: confirmed
//     seen values include Zillow, Realtor.com, RentEngine, Apartments.com,
//     Website Widget, Text AI, Zumper, Rent.com, Homes.com, Hotpads, Phone
//     Call, For Rent Sign, Walk-In, Text Message, Other, plus case/naming
//     duplicates ("Rent.com" / "rent.com" / "rent" all mean the same
//     thing). normalizeProspectSource() below collapses known duplicates;
//     everything else passes through as-is rather than being forced into
//     a fixed enum, so a brand-new source RentEngine adds later still
//     shows up (labeled honestly) instead of silently becoming "Other".
//   - Real `status` values (16 confirmed, Postgres enum leasing_event_type
//     on RentEngine's side): New, Contacted, Awaiting Information, Showing
//     Desired, Showing Canceled, Missed Showing, Application Sent to
//     Prospect, Application Received, Application Approved, Prescreen
//     Rejected, Still Deciding, Not Interested, Withdrawn, Blocklist
//     Prospect, Unit of Interest Unavailable, Ghosting, Moved In. There is
//     no separate "funnel" object anywhere in the API — the Leasing Funnel
//     tile is built by bucketing raw prospects by these status values (see
//     summarizeLeasingFunnel below).
//   - /units: real fields include status ("Leased" | "Available"),
//     is_occupied (bool), earliest_showing_date, earliest_move_in_date.
//     Confirmed live: these two fields DISAGREE on ~30% of real records —
//     e.g. status="Available" + is_occupied=true happens when a unit is
//     pre-leased (future tenant signed, current tenant hasn't moved out
//     yet) and RentEngine keeps it marketed/on-market until the actual
//     move-out; conversely some status="Leased" + is_occupied=false
//     records look like stale listings (old updated_at, no move-in date
//     ever set). See summarizeUnitsOnMarket's own comment for the
//     judgment call this forces.
//   - /units only ever returns 61 records total for this account (limit=
//     100 still returns 61, offset/page both 400) — this is NOT the full
//     ~230-unit Buildium portfolio, it's only the units RentEngine has
//     ever been asked to market. "Units on Market" / DOM figures are
//     scoped to this smaller RentEngine-tracked set, not the whole
//     portfolio, and that distinction must stay visible to Jason rather
//     than implying these are portfolio-wide numbers.
//   - No days_on_market field and no history/trend endpoint exists
//     anywhere in this API. DOM cannot be computed at all (there's no
//     "listed_at" style field to subtract from) — flagged as genuinely
//     unavailable, not guessed from earliest_showing_date (which is a
//     showing date, not a listing date, and is null on many records).
//   - /calls and /messages require BOTH prospect_id/phone AND account_ids,
//     one call per prospect — no bulk/account-wide endpoint exists. With
//     3,771 prospects and a confirmed 30 req/min rate limit
//     (X-Ratelimit-Limit: 30 header on every response), calling this live
//     per dashboard page load is an N+1 problem that would take over two
//     hours to complete once, every time. This must run as a scheduled
//     background sync into our own database, never on the request path —
//     see src/rentengine/callActivitySync.ts.
//   - No reporting/summary endpoint exists at all. Every KPI below is
//     computed here from raw prospects/units/calls/messages records, not
//     fetched pre-aggregated.
export class RentEngineNotConnectedError extends Error {
  constructor() {
    super("RentEngine is not connected (RENTENGINE_API_KEY is not set).");
    this.name = "RentEngineNotConnectedError";
  }
}

export class RentEngineApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
    this.name = "RentEngineApiError";
  }
}

function rentEngineHeaders(): Record<string, string> {
  const env = loadEnv();
  return {
    Authorization: `Bearer ${env.RENTENGINE_API_KEY}`,
    Accept: "application/json",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// CONFIRMED LIVE 2026-07-05: fetching all ~61 RentEngine-tracked units'
// leasing-performance data produces many real HTTP 429s (rate limited),
// even at the existing 5-at-a-time batching in fetchLeasingPerformanceForAllUnits.
// Before this fix, a 429 was treated the same as any other failure —
// logged and silently skipped, quietly under-counting Property Health,
// Completion Rate, Days on Market, and Marketing Activity with no visible
// error anywhere. Retry specifically on 429, honoring a real Retry-After
// header when RentEngine sends one, else exponential backoff
// (1s, 2s, 4s) — only after these retries are exhausted does the caller's
// existing "log and skip this one unit" behavior kick in.
const RATE_LIMIT_BACKOFFS_MS = [1000, 2000, 4000];

async function rentEngineGet<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, any>): Promise<T> {
  const env = loadEnv();
  let lastError: RentEngineApiError | null = null;

  for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFFS_MS.length; attempt++) {
    // Only the actual HTTP attempt goes through the global spacer, not the
    // backoff sleep below — a retry's own wait is specific to THIS caller
    // and shouldn't hold up an unrelated caller's turn in the shared queue.
    const res = await rentEngineLimiter.run(() => fetch(`${env.RENTENGINE_BASE_URL}${path}`, { headers: rentEngineHeaders() }));
    if (res.status !== 429) {
      if (!res.ok) {
        const body = await res.text().catch(() => "<no body>");
        throw new RentEngineApiError(`RentEngine API error ${res.status} on ${path}`, res.status, body);
      }
      const json = await res.json();
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new RentEngineApiError(
          `RentEngine API response for ${path} did not match expected shape: ${parsed.error.message}`,
          res.status,
          JSON.stringify(json)
        );
      }
      return parsed.data;
    }

    // 429 — retry if we have attempts left, otherwise fall through and throw.
    const body = await res.text().catch(() => "<no body>");
    lastError = new RentEngineApiError(`RentEngine API error 429 (rate limited) on ${path}`, 429, body);
    if (attempt < RATE_LIMIT_BACKOFFS_MS.length) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterMs = retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))
        ? Number(retryAfterHeader) * 1000
        : RATE_LIMIT_BACKOFFS_MS[attempt];
      logWarn("RentEngine 429 rate limited, retrying with backoff", {
        path,
        attempt: attempt + 1,
        waitMs: retryAfterMs,
        usedRetryAfterHeader: Boolean(retryAfterHeader),
      });
      await sleep(retryAfterMs);
    }
  }

  // Retries exhausted — throw the last 429 so the caller's existing
  // catch/skip logic handles it, same as any other real failure.
  throw lastError;
}

// Confirmed real, cursor-paged (created_after/created_before), max 100/page,
// no total-count or "has more" signal on this endpoint — same rule as
// Buildium's own pager: fewer rows than pageSize means last page. Capped at
// 100 pages (10,000 prospects) as a hard safety stop; the real account has
// 3,771 total, well under that.
//
// FIXED 2026-07-05, root cause of the "New Prospects" 3-way mismatch (tile
// 198/247 vs drill-down 209/249 vs by-source chart 207/247 — exact counts
// vary by day, always drill-down = tile/chart + ~2): created_after appears
// to be INCLUSIVE of a record whose created_at exactly equals windowStart
// (confirmed by comparing raw ids returned across page boundaries — the
// last record of page N reappears as the first record of page N+1).
// Anchoring the next page's created_after on the previous page's own last
// record therefore re-fetches that same record, once per page boundary
// crossed. The tile (leasing-performance per-unit reporting) and the
// by-source chart (/reporting/marketing-sources) both come from RentEngine's
// own server-side aggregation and were already correct/deduplicated; this
// raw /prospects list-fetching path was the one with the bug. De-duping by
// id after collecting all pages fixes it regardless of the API's exact
// inclusive/exclusive boundary semantics, rather than guessing at an
// off-by-one adjustment to the cursor itself.
async function rentEngineGetAllProspectPages<T extends { id: number; created_at: string }>(
  fromDate: string,
  toDate: string,
  schema: z.ZodType<T[], z.ZodTypeDef, any>,
  pageSize = 100
): Promise<T[]> {
  const results: T[] = [];
  // Walk forward in created_after windows rather than a single from/to
  // call: the API returns whatever matches the window in one shot (no
  // page cursor token), so re-querying with a narrowing created_after
  // anchored on the last-seen record's created_at is how "the next page"
  // is actually expressed for this endpoint.
  let windowStart = fromDate;
  for (let page = 0; page < 100; page++) {
    const rows = await rentEngineGet<T[]>(
      `/prospects?created_after=${encodeURIComponent(windowStart)}&created_before=${encodeURIComponent(
        toDate
      )}&limit=${pageSize}`,
      schema
    );
    if (rows.length === 0) break;
    results.push(...rows);
    if (rows.length < pageSize) break;
    windowStart = rows[rows.length - 1].created_at;
  }

  return dedupeById(results);
}

// Keeps the FIRST occurrence of each id, in original order — exported and
// tested on its own since rentEngineGetAllProspectPages itself makes real
// HTTP calls and isn't unit-testable in isolation.
export function dedupeById<T extends { id: number }>(rows: T[]): T[] {
  const seen = new Set<number>();
  const deduped: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    deduped.push(row);
  }
  return deduped;
}

// Real prospect field names, confirmed live. name/email/phone/notes/etc.
// exist but aren't needed for the dashboard KPIs below, so they're left
// out of the schema (zod's default behavior on an object schema is to
// ignore unrecognized keys, not reject them, so this is safe against the
// API adding more fields later).
const prospectSchema = z.object({
  id: z.number(),
  // name — ADDED 2026-07-13 for the Leasing Funnel drill-downs, per Jason
  // directly, to match the vendor's Name column. CORRECTED same day:
  // first pass assumed this was always a non-null string (having seen
  // "Unknown" rendered on the vendor's site) — CONFIRMED LIVE that's the
  // vendor's own frontend fallback text, not the real API value; RentEngine
  // genuinely returns null for some prospects with no name on file, and a
  // non-nullable schema here was silently crashing the whole /prospects
  // fetch (same failure mode status was already guarded against above).
  name: z.string().nullable(),
  status: z.string(), // 16 confirmed real enum values — see file header. Kept as string, not z.enum, so an unexpected 17th value doesn't crash parsing; summarizeLeasingFunnel below silently excludes anything unrecognized from every stage bucket rather than crashing.
  source: z.string(), // messier than any fixed list — see normalizeProspectSource
  unit_of_interest: z.number().nullable(),
  created_at: z.string(),
});
export type RentEngineProspect = z.infer<typeof prospectSchema>;

export async function fetchProspects(fromDate: string, toDate: string): Promise<RentEngineResult<RentEngineProspect[]>> {
  return withConnectionGuard(() => rentEngineGetAllProspectPages(fromDate, toDate, z.array(prospectSchema)));
}

// Real unit field names, confirmed live. Only 61 total records exist for
// this account (see file header) — every fetchUnits caller must treat
// that as the full available set, not a paginated slice of something
// bigger.
//
// FIXED 2026-07-10: status used to be a strict z.enum(["Leased",
// "Available"]) — CONFIRMED LIVE this was actively crashing the entire
// /units fetch, and every tile that depends on it (Property Health, Days
// on Market, Marketing Activity, Units on Market), because RentEngine's
// real account now has units in "On Hold" and "Incomplete" too (confirmed
// against the RentEngine UI itself — both are real, ordinary statuses
// their own screen shows, not glitches). One bad value anywhere in the
// array fails the whole array under zod, same failure mode the
// `prospect.status` field below already guards against — status is now a
// plain string here for the same reason, so a 5th/6th/7th real value
// RentEngine adds later doesn't take the whole fetch down again.
// address — ADDED 2026-07-13 for the Avg/Median Days on Market drill-down,
// per Jason directly. CONFIRMED LIVE real field on every unit (e.g. real
// case, unit 41121: {formatted_address: "9117 Chesapeake Blvd #5", ...}) —
// was already being fetched and silently dropped since it wasn't in this
// schema. This is the ONLY real address source for RentEngine's own
// per-unit leasing-performance rows (unit_id there has no matching Buildium
// UnitId — confirmed live, RentEngine uses its own separate ID space, e.g.
// 41121 vs Buildium's 803831-range IDs — so there is no Buildium-side join
// available; this field is the only way to show a real address here).
const unitSchema = z.object({
  id: z.number(),
  status: z.string(),
  is_occupied: z.boolean(),
  earliest_showing_date: z.string().nullable(),
  earliest_move_in_date: z.string().nullable(),
  updated_at: z.string(),
  address: z
    .object({
      formatted_address: z.string().nullable(),
    })
    .nullable(),
});
export type RentEngineUnit = z.infer<typeof unitSchema>;

export async function fetchUnits(): Promise<RentEngineResult<RentEngineUnit[]>> {
  return withConnectionGuard(() => rentEngineGet("/units?limit=100", z.array(unitSchema)));
}

// /calls and /messages share this envelope shape (confirmed live) — the
// opposite of /prospects and /units, which are bare arrays. Both require
// prospect_id AND account_ids; there's no bulk/account-wide variant.
function callOrMessageEnvelopeSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    page: z.object({
      limit: z.number(),
      page_number: z.number(),
      has_more: z.boolean(),
      next_page_number: z.number().nullable(),
    }),
  });
}

// CONFIRMED LIVE 2026-07-03: at least one real /messages record has
// direction: null (not merely absent) — .optional() alone rejects that,
// since optional only allows the key to be missing/undefined, not
// explicitly null. .nullable().optional() accepts both, matching what a
// real response can actually contain.
const callSchema = z.object({
  id: z.number().optional(),
  prospect_id: z.number().optional(),
  direction: z.string().nullable().optional(),
  created_at: z.string().optional(),
});
export type RentEngineCall = z.infer<typeof callSchema>;

const messageSchema = z.object({
  id: z.number().optional(),
  prospect_id: z.number().optional(),
  direction: z.string().nullable().optional(),
  created_at: z.string().optional(),
});
export type RentEngineMessage = z.infer<typeof messageSchema>;

// Confirmed live: requires BOTH prospect_id and account_ids, one call at a
// time — no bulk endpoint. Callers must NOT fan this out live across
// thousands of prospects on a page-load path (confirmed 30 req/min rate
// limit via X-Ratelimit-Limit response header — 3,771 prospects would take
// over two hours per full pass). This is only meant to be called from the
// scheduled background sync (src/rentengine/callActivitySync.ts), never
// directly from an API route.
export async function fetchCallsForProspect(prospectId: number, accountId: string): Promise<RentEngineCall[]> {
  const result = await rentEngineGet(
    `/calls?prospect_id=${prospectId}&account_ids=${encodeURIComponent(accountId)}`,
    callOrMessageEnvelopeSchema(callSchema)
  );
  return result.data;
}

export async function fetchMessagesForProspect(prospectId: number, accountId: string): Promise<RentEngineMessage[]> {
  const result = await rentEngineGet(
    `/messages?prospect_id=${prospectId}&account_ids=${encodeURIComponent(accountId)}`,
    callOrMessageEnvelopeSchema(messageSchema)
  );
  return result.data;
}

// Generic wrapper: every RentEngine fetch function returns this shape so
// callers (and the REST endpoints) can render a consistent "not connected"
// state without a try/catch at every call site.
export interface RentEngineResult<T> {
  connected: boolean;
  data: T | null;
  error: string | null;
}

async function withConnectionGuard<T>(fn: () => Promise<T>): Promise<RentEngineResult<T>> {
  if (!isRentEngineConnected()) {
    return { connected: false, data: null, error: null };
  }
  try {
    const data = await fn();
    return { connected: true, data, error: null };
  } catch (err) {
    logWarn("RentEngine call failed", { error: err instanceof Error ? err.message : String(err) });
    return { connected: true, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================================
// Source normalization (New Prospects by Source tile)
// ============================================================================
//
// Confirmed live duplicates for this account: "Rent.com", "rent.com", and
// "rent" are the same source with different casing/truncation. Everything
// else passes through UNCHANGED (only exact known variants get remapped)
// rather than being squeezed into a fixed enum, per the research finding
// that the real source list is longer and messier than the original spec
// assumed and may grow further.
const SOURCE_NORMALIZATION_MAP: Record<string, string> = {
  "rent.com": "Rent.com",
  rent: "Rent.com",
};

export function normalizeProspectSource(rawSource: string): string {
  const key = rawSource.trim().toLowerCase();
  return SOURCE_NORMALIZATION_MAP[key] ?? rawSource.trim();
}

export interface SourceCount {
  source: string;
  count: number;
}

export function summarizeProspectsBySource(prospects: RentEngineProspect[]): SourceCount[] {
  const counts = new Map<string, number>();
  for (const p of prospects) {
    const normalized = normalizeProspectSource(p.source);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
}

// ============================================================================
// Leasing Funnel (bucketed by real status values — no separate funnel
// object exists in RentEngine's API, confirmed)
// ============================================================================
//
// Funnel stage membership, mapped from the 16 confirmed real status
// values. A prospect occupies EVERY stage it has passed through, not just
// its current/latest status — e.g. a prospect currently "Application
// Received" counts toward showingsScheduled, showingsCompleted, AND
// applications, because reaching "Application Received" implies a
// showing happened first. This is a funnel (how far did prospects get),
// not a snapshot of current status distribution.
const SHOWING_SCHEDULED_STATUSES = new Set([
  "Showing Desired",
  "Showing Canceled",
  "Missed Showing",
  "Application Sent to Prospect",
  "Application Received",
  "Application Approved",
  "Prescreen Rejected",
  "Still Deciding",
  "Moved In",
]);
const SHOWING_COMPLETED_STATUSES = new Set([
  "Application Sent to Prospect",
  "Application Received",
  "Application Approved",
  "Prescreen Rejected",
  "Still Deciding",
  "Moved In",
]);
const APPLICATION_STATUSES = new Set([
  "Application Received",
  "Application Approved",
  "Prescreen Rejected",
  "Still Deciding",
  "Moved In",
]);
const MOVE_IN_STATUSES = new Set(["Moved In"]);

export interface LeasingFunnelSummary {
  prospects: number;
  showingsScheduled: number;
  showingsCompleted: number;
  applications: number;
  moveIns: number;
}

export function summarizeLeasingFunnel(prospects: RentEngineProspect[]): LeasingFunnelSummary {
  let showingsScheduled = 0;
  let showingsCompleted = 0;
  let applications = 0;
  let moveIns = 0;

  for (const p of prospects) {
    if (SHOWING_SCHEDULED_STATUSES.has(p.status)) showingsScheduled++;
    if (SHOWING_COMPLETED_STATUSES.has(p.status)) showingsCompleted++;
    if (APPLICATION_STATUSES.has(p.status)) applications++;
    if (MOVE_IN_STATUSES.has(p.status)) moveIns++;
  }

  return { prospects: prospects.length, showingsScheduled, showingsCompleted, applications, moveIns };
}

// Per-stage record list behind each Leasing Funnel bar — ADDED 2026-07-13,
// per Jason directly, to match the vendor's own drill-down (clicking a
// stage opens the real prospects behind that count). Reuses the exact
// same status sets summarizeLeasingFunnel above buckets on, and the same
// already-fetched prospect rows — no extra RentEngine calls. A prospect
// that reached a later stage still shows up in every earlier stage's list
// too (see the funnel-membership comment above), matching how the summary
// counts already work.
export type LeasingFunnelStage = "prospects" | "showingsScheduled" | "showingsCompleted" | "applications" | "moveIns";

export function leasingFunnelStageRows(prospects: RentEngineProspect[], stage: LeasingFunnelStage): RentEngineProspect[] {
  switch (stage) {
    case "prospects":
      return prospects;
    case "showingsScheduled":
      return prospects.filter((p) => SHOWING_SCHEDULED_STATUSES.has(p.status));
    case "showingsCompleted":
      return prospects.filter((p) => SHOWING_COMPLETED_STATUSES.has(p.status));
    case "applications":
      return prospects.filter((p) => APPLICATION_STATUSES.has(p.status));
    case "moveIns":
      return prospects.filter((p) => MOVE_IN_STATUSES.has(p.status));
  }
}

// ============================================================================
// Units on Market
// ============================================================================
//
// FIXED 2026-07-13, per Jason directly: was filtering to status==="Available"
// only, which silently dropped every real "On Hold" unit (2 real cases
// confirmed live: 9117 Chesapeake Boulevard #4, 1318 River Birch Run South
// — both genuinely still being marketed, just paused). CONFIRMED LIVE
// against the vendor site's own drill-down note for this exact tile: "All
// RentEngine units whose status is not 'Leased' (Available + On Hold). The
// 'is_occupied' flag is intentionally ignored because it lags reality."
//
// CORRECTED same day, per Jason directly: first pass generalized that note
// into status !== "Leased" (anything non-Leased counts), treating "Available
// + On Hold" as just an example. It wasn't — Jason's own manual count (12)
// caught a real case this broke: a unit with status "Incomplete" (1316
// Wellfleet Court #1) got counted as on-market even though it has NO real
// marketing history at all (confirmed live: never once appeared in
// RentEngine's leasing-performance report — null days_on_market, null
// property_health) — a draft listing RentEngine knows about but that was
// never actually published. The vendor's parenthetical is the real,
// exhaustive rule, not an example: only Available or On Hold count.
//
// The is_occupied judgment call (still valid, cross-confirmed by the
// vendor's own note above): ~28% of Available units in this account (17 of
// 61 in the sample pulled 2026-07-03) also have is_occupied=true.
// Investigation of those records shows a consistent pattern — a future
// earliest_move_in_date is set on every one of them, meaning these are
// units with a CURRENT tenant still in place but ALREADY leased to a
// future tenant; RentEngine continues marketing/showing them until the
// actual move-out, which is exactly what "on market" should mean for a PM
// tracking marketing pipeline. The alternative (status="Available" AND
// is_occupied=false) would undercount real active marketing effort by
// excluding every pre-leased-but-still-occupied unit.
export interface UnitsOnMarketSummary {
  unitsOnMarket: number;
  totalUnitsTracked: number;
}

// Single source of truth for "is this unit on the market" — used by the
// summary count above AND the drill-down route (src/api/rentEngineRoutes.ts
// /api/rentengine/units/on-market), so the two can never drift apart the
// way they briefly did on 2026-07-13.
export function isUnitOnMarket(status: string): boolean {
  return status === "Available" || status === "On Hold";
}

export function summarizeUnitsOnMarket(units: RentEngineUnit[]): UnitsOnMarketSummary {
  const onMarket = units.filter((u) => isUnitOnMarket(u.status));
  return { unitsOnMarket: onMarket.length, totalUnitsTracked: units.length };
}

// ============================================================================
// Reporting API — REAL endpoint, discovered 2026-07-04 via RentEngine's own
// public docs (https://docs.rentengine.io/openapi), which Jason found using
// the docs site's own search after guessed paths against the plain API
// failed. This supersedes the "no reporting endpoint exists" conclusion
// above for everything covered here — that conclusion was correct for the
// endpoints tried at the time, just incomplete.
//
// CONFIRMED LIVE 2026-07-04 against a real unit (id 41121):
//   GET /reporting/leasing-performance/units/{unitId}?start=...&end=...
//   -> {unit_id, days_on_market, property_health, benchmark_leads_since_last_price_change,
//       new_prospects, showings_scheduled, showings_completed, applications_requested,
//       applications_submitted, active_prospects, upcoming_showings, outbound_texts,
//       total_calls, showing_feedback: [{prospect_id, prospect_name, created_at, feedback}]}
// property_health real enum: "Off-Market" | "Healthy" | "At-risk" | "On Hold" |
// "Waitlist" | "Commercial" | "Unknown" — exact match to the real vendor
// site's Property Health categories. THIS IS THE REAL SOURCE for both Days
// on Market and Property Health — replaces the Buildium-derived
// src/kpi/propertyHealth.ts formula and the "genuinely not available"
// conclusion for DOM above. No account_ids param needed (unlike the other
// reporting endpoints below) and no 32-day span limit found (tested a
// Jan-to-July span live, worked fine) — only per-unit, so aggregating
// across RentEngine's ~61 tracked units means ~61 calls, well within the
// confirmed 30-req/5s rate limit (X-Ratelimit-Limit header) if lightly
// paced. Must run as a background sync (same pattern as
// callActivitySync.ts), not live on every dashboard page load.
const leasingPerformanceSchema = z.object({
  unit_id: z.number(),
  days_on_market: z.number().nullable(),
  property_health: z.string(), // kept as string (not z.enum) so an unrecognized future value doesn't crash parsing, same defensive pattern as prospect.status
  new_prospects: z.number(),
  showings_scheduled: z.number(),
  showings_completed: z.number(),
  applications_requested: z.number(),
  applications_submitted: z.number(),
  active_prospects: z.number(),
  upcoming_showings: z.number(),
  outbound_texts: z.number(),
  total_calls: z.number(),
  showing_feedback: z.array(
    z.object({
      prospect_id: z.number(),
      prospect_name: z.string().nullable(),
      created_at: z.string(),
      feedback: z.string().nullable(),
    })
  ),
});
export type RentEngineLeasingPerformance = z.infer<typeof leasingPerformanceSchema>;

// CONFIRMED LIVE 2026-07-06: this endpoint requires start/end as full
// ISO date-time strings, not bare YYYY-MM-DD — a bare date 400s with
// {"error":"Invalid query parameters", ...,"message":"must match format
// \"date-time\""}. toDateTimeParam converts either shape safely (a bare
// date is midnight UTC that day; a real datetime already provided passes
// through unchanged).
function toDateTimeParam(dateOrDateTime: string): string {
  return dateOrDateTime.includes("T") ? dateOrDateTime : `${dateOrDateTime}T00:00:00.000Z`;
}

export async function fetchLeasingPerformanceForUnit(
  unitId: number,
  fromDate: string,
  toDate: string
): Promise<RentEngineLeasingPerformance> {
  return rentEngineGet(
    `/reporting/leasing-performance/units/${unitId}?start=${encodeURIComponent(
      toDateTimeParam(fromDate)
    )}&end=${encodeURIComponent(toDateTimeParam(toDate))}`,
    leasingPerformanceSchema
  );
}

// Fetches leasing performance for every RentEngine-tracked unit, paced to
// stay well under the confirmed 30-req/5s rate limit (5 concurrent, no
// tighter delay needed at this volume — ~61 units finishes in a few
// seconds). A single unit's failure doesn't abort the whole batch (logged
// and skipped), since one bad/rate-limited response shouldn't blank out the
// other 60 units' real data.
//
// CONFIRMED LIVE 2026-07-05: this batching (5 concurrent, not an unbounded
// Promise.all across all ~61) was already in place and is NOT what was
// causing real 429s — the account's real rate limit is tighter in practice
// than the 5-at-a-time batching alone accounts for. The actual fix is at
// the single-request level: rentEngineGet() above now retries a 429 with
// backoff before giving up, so a unit that gets rate-limited on its first
// attempt usually still gets real data instead of being silently skipped.
// Only after retries are exhausted does this per-unit skip-and-log below
// actually fire.
export async function fetchLeasingPerformanceForAllUnits(
  fromDate: string,
  toDate: string
): Promise<RentEngineResult<RentEngineLeasingPerformance[]>> {
  return withConnectionGuard(async () => {
    const unitsResult = await fetchUnits();
    if (!unitsResult.connected || !unitsResult.data) {
      throw new Error(unitsResult.error ?? "RentEngine units unavailable");
    }
    const results: RentEngineLeasingPerformance[] = [];
    const CONCURRENCY = 5;
    const units = unitsResult.data;
    for (let i = 0; i < units.length; i += CONCURRENCY) {
      const batch = units.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((u) => fetchLeasingPerformanceForUnit(u.id, fromDate, toDate))
      );
      for (const s of settled) {
        if (s.status === "fulfilled") {
          results.push(s.value);
        } else {
          logWarn("RentEngine leasing-performance fetch failed for one unit, skipping", {
            error: s.reason instanceof Error ? s.reason.message : String(s.reason),
          });
        }
      }
    }
    return results;
  });
}

export interface DaysOnMarketSummary {
  avgDaysOnMarket: number | null;
  medianDaysOnMarket: number | null;
  unitsWithData: number;
  unitsTotal: number;
}

// FIXED 2026-07-04: was averaging days_on_market across ALL 61
// RentEngine-tracked units, including ~44 that are already Off-Market
// (leased/no-longer-listed). An off-market unit's days_on_market is a
// frozen historical value from whenever it was last actually listed, not
// a "how long has this been sitting on the market right now" figure — so
// including it drags the average toward small, stale numbers rather than
// reflecting current marketing performance.
//
// CONFIRMED LIVE 2026-07-04 against Jason's real account, cross-checked
// against the vendor site side-by-side: restricting to property_health
// === "Healthy" (RentEngine's own definition of "currently actively
// marketed") drops the tracked set from 61 to 17 units — exactly matching
// the already-confirmed-correct "Units on Market: 17" tile — and the
// resulting average (27.65, rounds to 28) and median (15) both match the
// vendor's real numbers exactly, versus the old all-61-unit average of
// 23. property_health lives on the same leasing-performance row as
// days_on_market (both come from GET /reporting/leasing-performance/units/{id}),
// so no extra fetch is needed to apply this filter.
export function summarizeDaysOnMarket(rows: RentEngineLeasingPerformance[]): DaysOnMarketSummary {
  const onMarketRows = rows.filter((r) => r.property_health === "Healthy");
  const values = onMarketRows.map((r) => r.days_on_market).filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (values.length === 0) {
    return { avgDaysOnMarket: null, medianDaysOnMarket: null, unitsWithData: 0, unitsTotal: onMarketRows.length };
  }
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
  return {
    avgDaysOnMarket: Math.round(avg * 10) / 10,
    medianDaysOnMarket: median,
    unitsWithData: values.length,
    unitsTotal: onMarketRows.length,
  };
}

// Per-unit detail behind Days on Market — for the Team Performance KPI
// drill-down. CONFIRMED against a real vendor screenshot (2026-07-19):
// unlike the avg/median stat above (which stays Healthy-only, already
// vendor-confirmed), the drill-down table itself lists every
// RentEngine-tracked unit regardless of health/status, with its real
// address and unit status alongside days_on_market.
export interface DaysOnMarketExplainRow {
  unitId: number;
  address: string | null;
  status: string | null;
  health: string;
  daysOnMarket: number | null;
}

export function daysOnMarketExplainRows(
  rows: RentEngineLeasingPerformance[],
  units: RentEngineUnit[]
): DaysOnMarketExplainRow[] {
  const unitById = new Map(units.map((u) => [u.id, u]));
  return rows
    .map((r) => {
      const unit = unitById.get(r.unit_id);
      return {
        unitId: r.unit_id,
        address: unit?.address?.formatted_address ?? null,
        status: unit?.status ?? null,
        health: r.property_health,
        daysOnMarket: r.days_on_market,
      };
    })
    .sort((a, b) => (b.daysOnMarket ?? -1) - (a.daysOnMarket ?? -1));
}

// Per-unit detail behind Showing Completion Rate.
export interface CompletionRateExplainRow {
  unitId: number;
  showingsScheduled: number;
  showingsCompleted: number;
}

export function completionRateExplainRows(rows: RentEngineLeasingPerformance[]): CompletionRateExplainRow[] {
  return rows
    .filter((r) => r.showings_scheduled > 0 || r.showings_completed > 0)
    .map((r) => ({ unitId: r.unit_id, showingsScheduled: r.showings_scheduled, showingsCompleted: r.showings_completed }));
}

export interface ShowingCompletionRateSummary {
  showingsCompleted: number;
  showingsScheduled: number;
  ratePercent: number | null;
}

// CONFIRMED LIVE 2026-07-06 against the vendor's own drill-down: this is a
// DIFFERENT, narrower calculation than the Dashboard tab's blanket
// Completion Rate tile (summarizeMarketingActivityFromReporting, which
// sums across every tracked unit) — this Portfolio Assistant KPI scopes to
// AVAILABLE listings only. "Available" here comes from the unit's own
// `status` field (fetchUnits, /units) — NOT property_health, which the
// leasing-performance report returns instead and has no "Leased" value of
// its own. RentEngine doesn't distinguish accompanied vs self-guided
// showings, so self-guided showings can't be excluded even though the
// vendor's own note says that would be more accurate.
//
// UPDATED 2026-07-10, per Jason directly: a unit sitting at "On Hold" or
// "Incomplete" isn't actually being shown to anyone right now (same as a
// Leased one, just for a different reason), so both are excluded from
// "available for showing" alongside Leased — not just Leased alone, which
// is all this checked before the status field crash fix above. Anything
// else (Available, Waitlist, or a future status not seen yet) still
// counts as available, same permissive-by-default posture as the schema
// change right above.
const NOT_AVAILABLE_FOR_SHOWING_STATUSES = new Set(["Leased", "On Hold", "Incomplete"]);

export function summarizeShowingCompletionRate(
  rows: RentEngineLeasingPerformance[],
  units: RentEngineUnit[]
): ShowingCompletionRateSummary {
  const availableUnitIds = new Set(
    units.filter((u) => !NOT_AVAILABLE_FOR_SHOWING_STATUSES.has(u.status)).map((u) => u.id)
  );
  const availableRows = rows.filter((r) => availableUnitIds.has(r.unit_id));
  const showingsScheduled = availableRows.reduce((sum, r) => sum + r.showings_scheduled, 0);
  const showingsCompleted = availableRows.reduce((sum, r) => sum + r.showings_completed, 0);
  return {
    showingsCompleted,
    showingsScheduled,
    ratePercent: showingsScheduled > 0 ? Math.round((showingsCompleted / showingsScheduled) * 1000) / 10 : null,
  };
}

export interface ShowingCompletionRateExplainRow {
  unitId: number;
  showingsScheduled: number;
  showingsCompleted: number;
}

export function showingCompletionRateExplainRows(
  rows: RentEngineLeasingPerformance[],
  units: RentEngineUnit[]
): ShowingCompletionRateExplainRow[] {
  const availableUnitIds = new Set(
    units.filter((u) => !NOT_AVAILABLE_FOR_SHOWING_STATUSES.has(u.status)).map((u) => u.id)
  );
  return rows
    .filter((r) => availableUnitIds.has(r.unit_id) && (r.showings_scheduled > 0 || r.showings_completed > 0))
    .map((r) => ({ unitId: r.unit_id, showingsScheduled: r.showings_scheduled, showingsCompleted: r.showings_completed }));
}

// Property Health categories, confirmed real from the reporting API itself
// — a superset of what src/kpi/propertyHealth.ts's Buildium-derived formula
// could ever produce (that formula never had a real way to detect Waitlist
// or On Hold; this endpoint does, directly). Per-unit here (RentEngine's
// own scope), not per-property like the old Buildium-based version — this
// is a real, different denominator (RentEngine's ~61 tracked units, not
// Buildium's ~201 active properties), and that distinction needs to stay
// visible rather than being silently conflated with the old property-level
// number.
export const PROPERTY_HEALTH_CATEGORIES = [
  "Healthy",
  "At-risk",
  "Waitlist",
  "On Hold",
  "Off-Market",
  "Commercial",
  "Unknown",
] as const;
export type RentEnginePropertyHealthCategory = (typeof PROPERTY_HEALTH_CATEGORIES)[number];

export interface PropertyHealthFromReportingSummary {
  totalUnits: number;
  countsByCategory: Record<string, number>;
}

export function summarizePropertyHealthFromReporting(
  rows: RentEngineLeasingPerformance[]
): PropertyHealthFromReportingSummary {
  const countsByCategory: Record<string, number> = Object.fromEntries(PROPERTY_HEALTH_CATEGORIES.map((c) => [c, 0]));
  for (const row of rows) {
    const category = PROPERTY_HEALTH_CATEGORIES.includes(row.property_health as RentEnginePropertyHealthCategory)
      ? row.property_health
      : "Unknown"; // a real but unrecognized value from a future API change routes to Unknown rather than crashing or being silently dropped
    countsByCategory[category] = (countsByCategory[category] ?? 0) + 1;
  }
  return { totalUnits: rows.length, countsByCategory };
}

export interface MarketingActivityFromReportingSummary {
  showingsScheduled: number;
  applicationsSubmitted: number;
  totalCalls: number;
  outboundTexts: number;
}

// Sums the per-unit reporting fields into portfolio-wide totals — this
// covers what the old N+1-per-prospect callActivitySync.ts was built to
// approximate, but sourced from RentEngine's own aggregation instead of
// ours. Kept separate from callActivitySync rather than deleting it in the
// same pass, since that job also backs the existing marketing-activity
// cache contract other code may still depend on — Tron should confirm the
// frontend is fully moved over before that job is retired.
//
// completionRate REMOVED 2026-07-13, per Jason directly: this blanket
// version (showings summed across EVERY tracked unit, Leased included) was
// the Dashboard tab's Completion Rate tile for a while, but CONFIRMED LIVE
// against the vendor's own drill-down that their real Completion Rate
// scopes to on-market units only (status not Leased/On Hold/Incomplete) —
// exactly what summarizeShowingCompletionRate below already computes
// (built a day later for the Team Performance KPI, never wired back to
// this Dashboard tile until now). The Dashboard tile now calls that
// function directly instead — see /api/rentengine/completion-rate.
//
// newProspects REMOVED 2026-07-19, per Jason directly: same category of
// bug as completionRate above. CONFIRMED LIVE against two of Jason's own
// vendor screenshots (from different dates) that the vendor's real "New
// Prospects" number always exactly equals their "New Prospects by Source"
// total and their Leasing Funnel's "Prospects" count — i.e. it's a plain
// count of prospect records created in the period, not this per-unit
// new_prospects field summed across every tracked unit (which undercounts
// by however many prospects have no unit_of_interest assigned — confirmed
// live, off by 1 out of 741 on a same-day check). The Dashboard tile now
// reads that same prospect-count directly — see
// GET /api/rentengine/marketing-activity in rentEngineRoutes.ts.
//
// showingsCompleted REMOVED 2026-07-19, per Jason directly: same category
// of bug again, third time. CONFIRMED LIVE against both of Jason's vendor
// screenshots that the vendor's real "Showings Completed" tile always
// exactly equals their own Leasing Funnel's "Showings completed" stage —
// i.e. summarizeLeasingFunnel's prospect-status-bucket count, NOT this
// per-unit showings_completed field summed across every tracked unit.
// (Confirmed live these three numbers can all differ for the same period:
// blanket sum 82, funnel bucket 87, Completion-Rate-scoped 49 — genuinely
// different populations, not rounding noise.) NOTE: a 2026-07-04 comment
// on this file once claimed the OPPOSITE — that the blanket sum matched
// the vendor (11) and the funnel bucket didn't (21). That comparison
// can't be re-run now (vendor access lost), but two independent
// screenshots on two different dates both agree with the funnel-bucket
// version, so this fix trusts that live evidence over the old comment.
// The Dashboard tile now reads summarizeLeasingFunnel(...).showingsCompleted
// directly — see GET /api/rentengine/marketing-activity in
// rentEngineRoutes.ts.
export function summarizeMarketingActivityFromReporting(
  rows: RentEngineLeasingPerformance[]
): MarketingActivityFromReportingSummary {
  return rows.reduce(
    (acc, r) => ({
      showingsScheduled: acc.showingsScheduled + r.showings_scheduled,
      applicationsSubmitted: acc.applicationsSubmitted + r.applications_submitted,
      totalCalls: acc.totalCalls + r.total_calls,
      outboundTexts: acc.outboundTexts + r.outbound_texts,
    }),
    { showingsScheduled: 0, applicationsSubmitted: 0, totalCalls: 0, outboundTexts: 0 }
  );
}

// ============================================================================
// Marketing Sources report — REAL endpoint (/reporting/marketing-sources),
// confirmed via RentEngine's real docs. Cleaner than the raw-prospect
// normalizeProspectSource() approach above (source_display is pre-
// normalized by RentEngine itself) — kept normalizeProspectSource/
// summarizeProspectsBySource in place as a fallback for when this endpoint
// or its required account_ids can't be resolved, rather than deleting
// working code.
//
// CONFIRMED account_id for this account (seen in a real RentEngine JWT
// payload during earlier research): 29a7815c-08a9-45df-a13a-f75376c95770.
const RENTENGINE_ACCOUNT_ID = "29a7815c-08a9-45df-a13a-f75376c95770";

// account_ids/start/end-based reporting endpoints share this envelope and
// this documented "span must not exceed 32 days" constraint.
function reportingEnvelopeSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    page: z.object({
      limit: z.number(),
      page_number: z.number(),
      has_more: z.boolean(),
      next_page_number: z.number().nullable(),
    }),
  });
}

// Splits a [from, to] range into <=32-day chunks (documented hard limit on
// the account_ids-based reporting endpoints). Confirmed necessary live: a
// 33+ day span on /reporting/marketing-sources returns a 400.
function chunkDateRangeBy32Days(fromDate: string, toDate: string): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  let cursor = new Date(fromDate);
  const end = new Date(toDate);
  const THIRTY_TWO_DAYS_MS = 32 * 24 * 60 * 60 * 1000;
  while (cursor < end) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + THIRTY_TWO_DAYS_MS, end.getTime()));
    chunks.push({ from: cursor.toISOString(), to: chunkEnd.toISOString() });
    cursor = chunkEnd;
  }
  return chunks.length > 0 ? chunks : [{ from: fromDate, to: toDate }];
}

const marketingSourceRowSchema = z.object({
  source_key: z.string().nullable(),
  source_display: z.string().nullable(),
  leads: z.number(),
  showings_scheduled: z.number(),
  showings_completed: z.number(),
  upcoming_showings: z.number(),
  applications_requested: z.number(),
  applications_submitted: z.number(),
  apps_approved: z.number(),
  rejected_prescreens: z.number(),
});
export type RentEngineMarketingSourceRow = z.infer<typeof marketingSourceRowSchema>;

// Fetches /reporting/marketing-sources across the full requested range,
// chunking into <=32-day windows and merging by source_display (RentEngine
// re-reports full per-window totals, not deltas, so merging means summing
// each window's counts per source).
export async function fetchMarketingSourcesReport(
  fromDate: string,
  toDate: string
): Promise<RentEngineResult<RentEngineMarketingSourceRow[]>> {
  return withConnectionGuard(async () => {
    const chunks = chunkDateRangeBy32Days(fromDate, toDate);
    const merged = new Map<string, RentEngineMarketingSourceRow>();
    for (const chunk of chunks) {
      let pageNumber = 0;
      for (let i = 0; i < 20; i++) {
        const result = await rentEngineGet(
          `/reporting/marketing-sources?account_ids=${encodeURIComponent(RENTENGINE_ACCOUNT_ID)}&start=${encodeURIComponent(
            chunk.from
          )}&end=${encodeURIComponent(chunk.to)}&limit=2000&page_number=${pageNumber}`,
          reportingEnvelopeSchema(marketingSourceRowSchema)
        );
        for (const row of result.data) {
          const key = row.source_display ?? row.source_key ?? "Unknown";
          const existing = merged.get(key);
          if (existing) {
            existing.leads += row.leads;
            existing.showings_scheduled += row.showings_scheduled;
            existing.showings_completed += row.showings_completed;
            existing.upcoming_showings += row.upcoming_showings;
            existing.applications_requested += row.applications_requested;
            existing.applications_submitted += row.applications_submitted;
            existing.apps_approved += row.apps_approved;
            existing.rejected_prescreens += row.rejected_prescreens;
          } else {
            merged.set(key, { ...row, source_display: key });
          }
        }
        if (!result.page.has_more) break;
        pageNumber = result.page.next_page_number ?? pageNumber + 1;
      }
    }
    return [...merged.values()].sort((a, b) => b.leads - a.leads);
  });
}

// ============================================================================
// Showings and Calls reports — CONFIRMED LIVE 2026-07-04 for drill-down
// record lists (New Prospects, Showings Completed, Total Calls/Outbound
// Texts tiles all need a record-level list, not just an aggregate — the
// aggregate versions already come from fetchLeasingPerformanceForAllUnits).
// Same account_ids/start/end/32-day-span-limit pattern as
// fetchMarketingSourcesReport above.
// prospect_type — ADDED 2026-07-19, confirmed live against the raw
// RentEngine API to exist (value "Self"), but turned out NOT to be the
// vendor's "Method" signal after all: every single row in a real period
// pull came back "Self" regardless of whether an agent conducted the
// showing, so it carries no information here. Kept in the schema since
// it's a real field, just unused for Method.
const showingReportRowSchema = z.object({
  showing_id: z.number(),
  prospect_id: z.number().nullable(),
  property_address: z.string().nullable(),
  prospect_name: z.string().nullable(),
  status: z.string().nullable(),
  feedback: z.string().nullable(),
  created_at: z.string(),
  planned_date_time: z.string().nullable(),
  showing_agent: z.string().nullable(),
  cancellation_reason: z.string().nullable(),
  prospect_type: z.string().nullable(),
});
export type RentEngineShowingReportRow = z.infer<typeof showingReportRowSchema>;

// Shared "was this showing actually completed" check — ADDED 2026-07-19,
// per Jason directly, so the Showings Completed TILE's count and its
// drill-down's row filter can never drift apart (same bug class already
// fixed for Completion Rate/New Prospects this session). CONFIRMED LIVE
// against a real vendor screenshot: their tile's number (76) matches a
// count of real /reporting/showings rows whose status is "Showing
// Complete" — this is that same substring check the drill-down route
// already used before this fix, just now reusable.
export function isShowingCompleted(status: string | null): boolean {
  return (status ?? "").toLowerCase().includes("complet");
}

// CORRECTED 2026-07-19 against a real vendor screenshot: the actual
// signal is whether a leasing agent conducted the showing (showing_agent
// set) vs. the prospect let themselves in (showing_agent null/blank) —
// prospect_type doesn't vary in practice, see schema comment above.
export function isShowingSelfGuided(showingAgent: string | null): boolean {
  return !showingAgent || showingAgent.trim() === "";
}

// Eastern-calendar-day string (YYYY-MM-DD) for a given ISO instant — the
// whole dashboard displays/reasons in America/New_York, so "was this
// logged within the period" has to compare calendar days in that zone,
// not raw UTC. CORRECTED 2026-07-19: an earlier version of the filter
// below compared raw UTC instants against the UTC period boundary, which
// let a showing created 2026-07-01T02:50 UTC (= 2026-06-30 10:50pm
// Eastern) into a "this month" (Jul 1-18) window — it passed the UTC
// check but displayed as June 30th, exactly the mismatch Jason caught.
function easternDateOnly(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
}

// CORRECTED 2026-07-19, per Jason directly: RentEngine's /reporting/showings
// start/end params filter by planned_date_time (when the showing was
// scheduled to happen), not by created_at (when it was logged) — confirmed
// live by a row logged 6/27 but scheduled for 7/6 coming back from a
// "this month" (7/1-7/18) query. That produced a nonsensical result: a
// showing dated 6/27 appearing on a "This month" report, and inflated our
// count above the vendor's (which scopes to created_at). Filtering here to
// created_at within the requested window keeps the tile's count and the
// drill-down's displayed date on the same field, and matches the vendor.
// fromDate/toDate arrive as "YYYY-MM-DDT00:00:00Z"/"YYYY-MM-DDT23:59:59Z" —
// the first 10 characters are the plain Eastern-business-day bounds this
// dashboard's period selector actually means.
export async function fetchShowingsReport(
  fromDate: string,
  toDate: string
): Promise<RentEngineResult<RentEngineShowingReportRow[]>> {
  const result = await withConnectionGuard(() =>
    fetchPagedReport(
      "/reporting/showings",
      fromDate,
      toDate,
      reportingEnvelopeSchema(showingReportRowSchema)
    )
  );
  if (!result.connected || !result.data) return result;
  const fromDateOnly = fromDate.slice(0, 10);
  const toDateOnly = toDate.slice(0, 10);
  return {
    ...result,
    data: result.data.filter((row) => {
      const loggedDate = easternDateOnly(row.created_at);
      return loggedDate >= fromDateOnly && loggedDate <= toDateOnly;
    }),
  };
}

// Shared pager for the account_ids/start/end/32-day-span-limit report
// endpoints that return a flat record list (not aggregated by a grouping
// key the way marketing-sources needs merging) — chunks the date range,
// pages within each chunk, concatenates everything.
async function fetchPagedReport<T>(
  path: string,
  fromDate: string,
  toDate: string,
  schema: z.ZodType<{ data: T[]; page: { has_more: boolean; next_page_number: number | null } }>
): Promise<T[]> {
  const chunks = chunkDateRangeBy32Days(fromDate, toDate);
  const rows: T[] = [];
  for (const chunk of chunks) {
    let pageNumber = 0;
    for (let i = 0; i < 20; i++) {
      const result = await rentEngineGet(
        `${path}?account_ids=${encodeURIComponent(RENTENGINE_ACCOUNT_ID)}&start=${encodeURIComponent(
          chunk.from
        )}&end=${encodeURIComponent(chunk.to)}&limit=2000&page_number=${pageNumber}`,
        schema
      );
      rows.push(...result.data);
      if (!result.page.has_more) break;
      pageNumber = result.page.next_page_number ?? pageNumber + 1;
    }
  }
  return rows;
}
