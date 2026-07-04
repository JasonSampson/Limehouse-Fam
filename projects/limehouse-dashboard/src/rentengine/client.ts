import { z } from "zod";
import { loadEnv, isRentEngineConnected } from "../config/env.js";
import { logWarn } from "../lib/logger.js";

// RESEARCH NOTE: RentEngine does not have a widely-published public API
// reference the way Buildium does — Jason has not yet confirmed whether his
// account has API access at all (see project brief). Every function in this
// file is written defensively behind isRentEngineConnected(): if
// RENTENGINE_API_KEY is blank/absent, every fetch* function below returns a
// clean "not connected" result instead of throwing, so the rest of the
// dashboard (Buildium-backed tiles, KPI scoring, etc.) works fully even
// with RentEngine never configured.
//
// The endpoint paths and response shapes below (/prospects, /showings,
// /units-on-market) are a BEST-GUESS placeholder structure based on what
// the vendor dashboard displays (prospect source tags, showing
// scheduled/completed counts, days-on-market by unit) — NOT confirmed
// against a real RentEngine API response. This must be verified against
// real API docs/access once Jason confirms RentEngine offers API access;
// until then, treat every schema/path here as unverified scaffolding, not
// fact. Do not remove this note until a live call has been made.
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

async function rentEngineGet<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, any>): Promise<T> {
  const env = loadEnv();
  const res = await fetch(`${env.RENTENGINE_BASE_URL}${path}`, { headers: rentEngineHeaders() });
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

export const RENT_ENGINE_LEAD_SOURCES = [
  "Zillow",
  "Realtor.com",
  "RentEngine",
  "Apartments.com",
  "Website Widget",
  "Text AI",
  "Zumper",
  "Other",
] as const;
export type RentEngineLeadSource = (typeof RENT_ENGINE_LEAD_SOURCES)[number];

const prospectSchema = z.object({
  id: z.string(),
  unitId: z.string().nullable(),
  source: z.enum(RENT_ENGINE_LEAD_SOURCES).catch("Other"),
  createdAt: z.string(),
});
export type RentEngineProspect = z.infer<typeof prospectSchema>;

const showingSchema = z.object({
  id: z.string(),
  unitId: z.string().nullable(),
  scheduledAt: z.string(),
  status: z.enum(["scheduled", "completed", "no_show", "cancelled"]),
});
export type RentEngineShowing = z.infer<typeof showingSchema>;

const unitOnMarketSchema = z.object({
  unitId: z.string(),
  propertyId: z.string().nullable(),
  listedAt: z.string(),
  daysOnMarket: z.number(),
});
export type RentEngineUnitOnMarket = z.infer<typeof unitOnMarketSchema>;

const callActivitySchema = z.object({
  count: z.number(),
  periodStart: z.string(),
  periodEnd: z.string(),
});

const textActivitySchema = z.object({
  count: z.number(),
  periodStart: z.string(),
  periodEnd: z.string(),
});

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

export async function fetchProspects(fromDate: string, toDate: string): Promise<RentEngineResult<RentEngineProspect[]>> {
  return withConnectionGuard(() =>
    rentEngineGet(`/prospects?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`, z.array(prospectSchema))
  );
}

export async function fetchShowings(fromDate: string, toDate: string): Promise<RentEngineResult<RentEngineShowing[]>> {
  return withConnectionGuard(() =>
    rentEngineGet(`/showings?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`, z.array(showingSchema))
  );
}

export async function fetchUnitsOnMarket(): Promise<RentEngineResult<RentEngineUnitOnMarket[]>> {
  return withConnectionGuard(() => rentEngineGet("/units-on-market", z.array(unitOnMarketSchema)));
}

export async function fetchCallActivity(fromDate: string, toDate: string): Promise<RentEngineResult<{ count: number }>> {
  return withConnectionGuard(async () => {
    const result = await rentEngineGet(
      `/activity/calls?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`,
      callActivitySchema
    );
    return { count: result.count };
  });
}

export async function fetchOutboundTextActivity(
  fromDate: string,
  toDate: string
): Promise<RentEngineResult<{ count: number }>> {
  return withConnectionGuard(async () => {
    const result = await rentEngineGet(
      `/activity/texts?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`,
      textActivitySchema
    );
    return { count: result.count };
  });
}
