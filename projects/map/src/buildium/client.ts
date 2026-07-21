import { z } from "zod";
import { loadEnv } from "../config/env.js";

// Buildium API client for Map. Adapted/extended from
// projects/late-rent-notices/src/buildium/client.ts rather than written
// from scratch, per Jason's standing rule against duplicating logic — the
// auth header construction, the buildiumGet() fetch/validate/error-wrap
// helper, and the properties/leases/tenants schemas below carry forward
// exactly the same CONFIRMED-live findings that file already earned
// (endpoint names, the `status=Active` / `leasestatuses=` query-param
// quirks, etc.), instead of re-guessing them here.
//
// This is a separate file, not a shared import, because Map and
// late-rent-notices are independent deployable apps with independent
// package.json/node_modules/deploys (the same "fully independent app"
// pattern Neo's schema.md confirms for the database layer) — there is no
// existing shared-package mechanism in this repo to import across
// projects/ directories. If a real second consumer of this client
// justifies extracting a shared `packages/buildium-client`, that's a
// cross-project refactor Oracle should scope deliberately, not something
// to back into silently here. Flagging this trade-off for Jason/Oracle,
// not deciding it unilaterally.
function buildiumHeaders(): Record<string, string> {
  const env = loadEnv();
  return {
    "x-buildium-client-id": env.BUILDIUM_CLIENT_ID,
    "x-buildium-client-secret": env.BUILDIUM_CLIENT_SECRET,
    Accept: "application/json",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// CONFIRMED LIVE (2026-07-20): a tight sequential loop of per-property
// Buildium calls (the shape syncBuildiumData's units/leases fetches run
// in) hit a real HTTP 429 partway through a 196-property sync — Oracle's
// spec's documented rate limit (10 concurrent requests/sec, back off and
// retry after ~200ms) is a real constraint at this portfolio's size, not
// theoretical. Retries a 429 up to 3 times with a fixed backoff rather
// than failing the whole property's sync outright; any other error status
// still throws immediately (a 429 is the only "just slow down" case).
const RATE_LIMIT_RETRY_DELAY_MS = 250;
const RATE_LIMIT_MAX_RETRIES = 3;

async function fetchWithRateLimitRetry(
  url: string,
  headers: Record<string, string>,
  method: "GET" | "POST" = "GET",
): Promise<Response> {
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers, method });
    if (res.status !== 429) return res;
    if (attempt < RATE_LIMIT_MAX_RETRIES) {
      await sleep(RATE_LIMIT_RETRY_DELAY_MS * (attempt + 1));
      continue;
    }
    return res; // exhausted retries — let the caller's !res.ok handling report it
  }
  // Unreachable, but keeps TypeScript happy about all paths returning.
  return fetch(url, { headers, method });
}

async function buildiumGet<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, any>): Promise<T> {
  const env = loadEnv();
  const res = await fetchWithRateLimitRetry(`${env.BUILDIUM_BASE_URL}${path}`, buildiumHeaders());
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

// Raw POST returning the parsed-but-unvalidated JSON body — used for the
// image-download two-step (metadata + signed URL). The rental-images
// download endpoint (see downloadPropertyImage below) is a POST, confirmed
// live; a strict zod schema would be premature for a single `{DownloadUrl}`
// shape that's only ever read once, right here.
async function buildiumPostRaw(path: string): Promise<unknown> {
  const env = loadEnv();
  const res = await fetchWithRateLimitRetry(`${env.BUILDIUM_BASE_URL}${path}`, buildiumHeaders(), "POST");
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new BuildiumApiError(`Buildium API error ${res.status} on ${path}`, res.status, body);
  }
  return res.json();
}

export class BuildiumApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
    this.name = "BuildiumApiError";
  }
}

// --- Properties ---
// CONFIRMED (late-rent-notices client.ts, live 2026-07-17): /v1/rentals,
// filtered server-side with status=Active (not isactive=true, which is
// silently ignored by Buildium).
const buildiumPropertyManagerSchema = z.object({
  Id: z.number(),
  FirstName: z.string().nullable(),
  LastName: z.string().nullable(),
  Email: z.string().email().nullable(),
});

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

export async function fetchProperties(): Promise<BuildiumProperty[]> {
  return buildiumGet<BuildiumProperty[]>("/rentals?status=Active&limit=1000", z.array(buildiumPropertySchema));
}

// --- Units ---
// CONFIRMED LIVE (2026-07-20, read-only, real Jason account): endpoint is
// GET /rentals/units?propertyids={id}, and the real field names are
// UnitBedrooms/UnitBathrooms/UnitSize — NOT Bedrooms/Bathrooms/
// SquareFootage as originally guessed from Oracle's research pass. This
// closes schema.md gap #1. MarketRent is also present at the unit level
// (worth flagging to Neo/Jason: this may reduce or remove the need for a
// separate RentEngine call for vacant-unit asking rent — noted, not acted
// on in this build pass since it wasn't part of the requested scope).
const buildiumUnitSchema = z.object({
  Id: z.number(),
  PropertyId: z.number(),
  UnitNumber: z.string().nullable(),
  UnitBedrooms: z.string().nullable().optional(),
  UnitBathrooms: z.string().nullable().optional(),
  UnitSize: z.number().nullable().optional(),
});

export type BuildiumUnit = z.infer<typeof buildiumUnitSchema>;

// CONFIRMED LIVE (2026-07-20): Buildium's UnitBedrooms/UnitBathrooms come
// back as word-based enum strings — e.g. "Studio", "FourBed",
// "TwoPointFiveBath" — NOT plain numbers or decimal text as originally
// guessed. A naive digit-extraction regex silently returned null for every
// real value observed (no digits appear in "FourBed" at all). This parses
// the English number word plus an optional "PointFive" suffix; returns
// null (not 0) for a value this parser doesn't recognize, since guessing 0
// bedrooms would be actively misleading — Tron's UI should treat null as
// "unknown," not "studio."
const WORD_TO_NUMBER: Record<string, number> = {
  studio: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export function parseUnitNumericField(value: string | null | undefined): number | null {
  if (!value) return null;
  const lower = value.toLowerCase();

  if (lower.includes("studio")) return 0;

  const wordMatch = lower.match(/^(one|two|three|four|five|six|seven|eight|nine|ten)/);
  if (wordMatch) {
    const base = WORD_TO_NUMBER[wordMatch[1]];
    return lower.includes("pointfive") ? base + 0.5 : base;
  }

  // Fall back to plain digits, in case some accounts/endpoints return
  // "1", "2.5" etc. directly rather than the word-based enum observed live.
  const digitMatch = value.match(/(\d+(\.\d+)?)/);
  return digitMatch ? Number(digitMatch[1]) : null;
}

export async function fetchUnitsForProperty(buildiumPropertyId: number): Promise<BuildiumUnit[]> {
  return buildiumGet<BuildiumUnit[]>(
    `/rentals/units?propertyids=${buildiumPropertyId}&limit=1000`,
    z.array(buildiumUnitSchema)
  );
}

// --- Leases ---
// CONFIRMED endpoint (late-rent-notices client.ts): /v1/leases,
// leasestatuses as a real array query param. late-rent-notices only ever
// needed Active leases; Map's schema deliberately keeps lease HISTORY
// (leases.lease_status CHECK IN Active/Future/Past, never overwritten),
// so this fetches all three statuses. NEEDS LIVE CONFIRMATION: whether
// Buildium accepts multiple leasestatuses values in one call the same way
// (repeated query param, confirmed pattern elsewhere in this codebase) —
// verify against a live sandbox call before running against production.
const buildiumTenantSchema = z.object({
  Id: z.number(),
  FirstName: z.string().nullable(),
  LastName: z.string().nullable(),
  // NEEDS LIVE CONFIRMATION: Map needs a phone number ("who to call" —
  // spec), not email (late-rent-notices' concern). Buildium's phone data
  // is very likely a PhoneNumbers array (Home/Work/Mobile), not a single
  // scalar field — modeled defensively here; getPrimaryPhone() below picks
  // the first available number rather than assuming a specific type is
  // always present.
  PhoneNumbers: z
    .array(z.object({ Number: z.string().nullable(), Type: z.string().nullable() }))
    .nullable()
    .optional(),
});

export function getPrimaryPhone(tenant: z.infer<typeof buildiumTenantSchema>): string | null {
  const first = (tenant.PhoneNumbers ?? []).find((p) => p.Number);
  return first?.Number ?? null;
}

const buildiumLeaseSchema = z.object({
  Id: z.number(),
  PropertyId: z.number(),
  UnitId: z.number(),
  LeaseStatus: z.enum(["Active", "Past", "Future"]),
  LeaseFromDate: z.string(),
  LeaseToDate: z.string().nullable(),
  // CONFIRMED LIVE (2026-07-20): rent lives under a nested AccountDetails
  // object (AccountDetails.Rent), not a flat CurrentRent field as
  // originally guessed. AccountDetails itself can apparently be absent on
  // some lease shapes, so it's optional/nullable defensively.
  AccountDetails: z.object({ Rent: z.number().nullable().optional() }).nullable().optional(),
  CurrentTenants: z.array(buildiumTenantSchema).nullable(),
});

export type BuildiumLease = z.infer<typeof buildiumLeaseSchema>;

export function currentRentFromLease(lease: BuildiumLease): number | null {
  return lease.AccountDetails?.Rent ?? null;
}

export async function fetchLeasesForProperty(buildiumPropertyId: number): Promise<BuildiumLease[]> {
  return buildiumGet<BuildiumLease[]>(
    `/leases?propertyids=${buildiumPropertyId}&leasestatuses=Active&leasestatuses=Future&leasestatuses=Past&limit=1000`,
    z.array(buildiumLeaseSchema)
  );
}

// --- Lease recurring charges (extra charges beyond base rent) ---
// CONFIRMED LIVE (2026-07-21, real Jason account, lease 2873091 — 2642 East
// Ocean View Ave Unit A1, and cross-checked against leases 2535032, 2050776,
// 2736118): GET /leases/{id}/recurringtransactions returns EVERY recurring
// line on the lease, not just extra charges — the rent line itself is in
// here too, distinguished by RentId being set (it points back at the
// /leases/{id}/rent sub-resource entry). A real extra recurring charge is
// RentId === null. Frequency/IsExpired matter too: the same feed can
// contain a genuine one-time fee ("Tenant Lease Renewal Fee", Frequency
// "OneTime", Duration "SpecificNumber") and a future already-scheduled rent
// increase (a second RentId-linked entry with a later FirstOccurrenceDate) —
// neither belongs in "current extra charges beyond rent". isExtraRecurringCharge
// below is the single filter for this; do not re-derive it elsewhere.
//
// Memo is free text a human typed into Buildium — confirmed inconsistent
// for the same real-world charge across leases ("Utility Rent -
// water/sewer/trash" vs "Water, Sewer, Trash", "Resident Benefits Package"
// vs "Resident Benefit Package"). Stored verbatim; only classified for
// display via src/lib/feeClassification.ts, never rewritten here.
const buildiumRecurringTransactionSchema = z.object({
  Id: z.number(),
  TransactionType: z.string(),
  IsExpired: z.boolean(),
  RentId: z.number().nullable(),
  Amount: z.number(),
  Memo: z.string().nullable(),
  Frequency: z.string(),
});

export interface BuildiumRecurringCharge {
  id: number;
  label: string;
  amount: number;
}

// The one real-data filter for "is this row an extra recurring charge
// beyond base rent" — see the confirmed-live findings in the comment above.
export function isExtraRecurringCharge(t: z.infer<typeof buildiumRecurringTransactionSchema>): boolean {
  return t.RentId === null && t.Frequency === "Monthly" && !t.IsExpired;
}

export async function fetchLeaseRecurringCharges(leaseId: number): Promise<BuildiumRecurringCharge[]> {
  const rows = await buildiumGet(
    `/leases/${leaseId}/recurringtransactions`,
    z.array(buildiumRecurringTransactionSchema)
  );
  return rows
    .filter(isExtraRecurringCharge)
    .map((t) => ({ id: t.Id, label: t.Memo ?? `Charge ${t.Id}`, amount: t.Amount }));
}

// --- Property photos ---
// CONFIRMED LIVE (2026-07-21, real Jason account, real credentials, all 196
// synced properties): the two endpoints Oracle's spec originally guessed at
// are both wrong, in different ways —
//
//   GET /rentals/{id}/files        -> 404 for every property. This path
//                                     doesn't exist; Buildium's error body
//                                     literally says endpoint/param names
//                                     are case-sensitive and to recheck the
//                                     docs, which is what turned up the fix.
//   GET /files?entityId=X&entityType=Rental
//                                  -> 200, but does NOT filter by entityId at
//                                     all — a bogus entityId (999999999)
//                                     returned the exact same global file
//                                     list as a real property id. Shipping
//                                     this would have silently attached
//                                     random properties' documents (lease
//                                     paperwork, insurance docs, etc., per
//                                     the account's real /files/categories
//                                     list) to the wrong property's photo.
//
// The correct endpoint is Buildium's dedicated Rental Images resource
// (developer.buildium.com's RentalPropertiesApi, RentalImageMessage) —
// GET /rentals/{propertyId}/images. This is a URL-PATH-scoped resource, not
// a query-filtered one, so the entityId bug class isn't structurally
// possible here. Verified across all 196 real synced properties: 0 non-200
// responses, and 20 properties came back with genuinely different, non-
// empty image lists (1 to 10 images each, distinct PhysicalFileName values
// per property) — confirmed this actually is per-property data, not the
// same global list twice. The other 176 properties correctly returned `[]`
// (no rental photos uploaded in Buildium for those units yet — a real data
// gap on Jason's side, not a sync bug).
//
// Real response fields (confirmed live, not from stale/guessed docs):
// Id, Description, PhysicalFileName, Provider, ShowInListing. There is no
// ContentType field on this resource (unlike the generic /files list) —
// content type is derived from PhysicalFileName's extension below.
//
// CORRECTED 2026-07-21, per Jason directly: the earlier assumption that
// "every item this endpoint returns is already an image" is wrong. This
// endpoint also returns embedded VIDEOS mixed into the same list — real,
// confirmed live example: property 348401 (1313 Tait Close)'s Id 2171022
// has `PhysicalFileName: "//www.youtube.com/embed/4YZ1e5Iacro"` and
// `Provider: "YouTube"`, `ShowInListing: true` — which the old selection
// logic in photoSync.ts happily picked as the "featured" photo (since it
// preferred whatever had ShowInListing=true), tried to download as an
// image, and got back YouTube's HTML page instead of a photo. `Provider`
// is the real signal: a genuine uploaded photo always has `Provider:
// "None"`; anything else (confirmed: "YouTube", plausibly "Vimeo"/other
// video hosts too) is external video content, not a downloadable image,
// and must be filtered out before photoSync.ts ever tries to pick a
// "primary" photo — see `isRealUploadedPhoto` below.
const buildiumRentalImageSchema = z.object({
  Id: z.number(),
  Description: z.string().nullable().optional(),
  PhysicalFileName: z.string().nullable(),
  Provider: z.string().nullable().optional(),
  ShowInListing: z.boolean().optional(),
});

export interface BuildiumPropertyImage {
  id: number;
  fileName: string;
  description: string | null;
  showInListing: boolean;
  provider: string;
}

// A genuine, downloadable photo has Provider "None" — anything else is
// externally-hosted video content (YouTube confirmed live, other video
// hosts plausible) that this sync must never try to download as an image.
// See the schema comment above for the real, confirmed example this fixes.
export function isRealUploadedPhoto(image: BuildiumPropertyImage): boolean {
  return image.provider === "None";
}

export async function fetchPropertyImages(buildiumPropertyId: number): Promise<BuildiumPropertyImage[]> {
  const rows = await buildiumGet(
    `/rentals/${buildiumPropertyId}/images?limit=1000`,
    z.array(buildiumRentalImageSchema)
  );
  return rows.map((r) => ({
    id: r.Id,
    fileName: r.PhysicalFileName ?? `image-${r.Id}`,
    provider: r.Provider ?? "None",
    description: r.Description ?? null,
    showInListing: r.ShowInListing ?? false,
  }));
}

// CONFIRMED LIVE (2026-07-21, real Jason account): photos in Buildium are
// actually uploaded at the UNIT level, not the property level — the
// property-level endpoint above (GET /rentals/{propertyId}/images) has only
// ever seen a photo for 20 of 196 real synced properties, while a spot
// check of unit 1621709 (property 167, 1505 Eagleton Lane) turned up 13 real
// photos, and 10/10 other randomly-sampled units each had real photos too.
// This isn't a Buildium data gap — the sync has been checking the wrong
// scope almost the whole time.
//
// The correct endpoint is GET /rentals/units/{unitId}/images — same
// resource family as the property-level one (`/rentals/...`), just nested
// under `units/{unitId}` instead of `{propertyId}` directly, and confirmed
// to return the identical response shape (Id, Description,
// PhysicalFileName, Provider, ShowInListing), so it reuses
// buildiumRentalImageSchema/BuildiumPropertyImage/isRealUploadedPhoto as-is
// rather than a parallel type. A bogus unit id 404s ("requested unit could
// not be found") rather than silently returning someone else's list, so
// this is genuinely path-scoped like the property-level endpoint — not the
// entityId-ignoring bug class the old /files?entityId= endpoint had.
//
// Property-level and unit-level photos are NOT mutually exclusive — both
// can have separate uploads for the same real-world property — so this is
// an ADDITIONAL source to check, not a replacement for fetchPropertyImages
// above. See the precedence logic in photoSync.ts for how the two are
// combined into one "primary" photo per property.
export async function fetchUnitImages(buildiumUnitId: number): Promise<BuildiumPropertyImage[]> {
  const rows = await buildiumGet(
    `/rentals/units/${buildiumUnitId}/images?limit=1000`,
    z.array(buildiumRentalImageSchema)
  );
  return rows.map((r) => ({
    id: r.Id,
    fileName: r.PhysicalFileName ?? `image-${r.Id}`,
    provider: r.Provider ?? "None",
    description: r.Description ?? null,
    showInListing: r.ShowInListing ?? false,
  }));
}

// Guesses a MIME type from the file extension, since the rental-images
// resource doesn't return ContentType directly (see note above). Falls
// back to image/jpeg — every result from this endpoint is a photo, so an
// unrecognized extension is still overwhelmingly likely to be a jpeg.
export function contentTypeFromFileName(fileName: string): string {
  const ext = (fileName.match(/\.(\w+)$/)?.[1] ?? "").toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
    case "jfif":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

// CONFIRMED LIVE BUG (2026-07-21, property 53/1313 Tait Close): the signed
// CloudFront URL from downloadrequests can return HTTP 200 with an HTML body
// (e.g. an expired/invalid signed URL, a redirect-to-login page) instead of
// real image bytes. res.ok alone doesn't catch this — a 200 is a 200 whether
// the body is a photo or a web page. Buildium also doesn't reliably send a
// trustworthy Content-Type on this endpoint, so the header can't be trusted
// either (this is how a text/html body got silently stored as a
// property_photos row with content_type recorded as if it were a real
// image). Checking the first few bytes against known image magic numbers is
// cheap and catches this class of bug regardless of what any header claims.
const IMAGE_SIGNATURES: Array<{ name: string; matches: (b: Buffer) => boolean }> = [
  { name: "jpeg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    name: "png",
    matches: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    name: "gif",
    matches: (b) =>
      b.length >= 6 &&
      b[0] === 0x47 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) &&
      b[5] === 0x61,
  },
  {
    name: "webp",
    matches: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
  { name: "bmp", matches: (b) => b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d },
];

// Exported for testing. Returns the detected format name, or null if the
// bytes don't match any known image signature.
export function detectImageFormat(bytes: Buffer): string | null {
  return IMAGE_SIGNATURES.find((sig) => sig.matches(bytes))?.name ?? null;
}

// Two-step download: mint a signed URL, then fetch the bytes. CONFIRMED LIVE
// (2026-07-21, real image, real property): this is a POST (not GET) to
// /rentals/{propertyId}/images/{imageId}/downloadrequests (plural
// "downloadrequests", and it needs propertyId in the path — the generic
// /files/{id}/downloadrequest used by the old code 404s for an image id,
// since images are their own resource, not a category of generic files).
// Response is { DownloadUrl }, a short-lived signed CloudFront URL —
// confirmed by actually downloading real bytes from it and checking the
// JPEG magic number (ff d8 ff) matched.
//
// CONFIRMED LIVE (2026-07-21): a unit-level image id does NOT download
// through this same property-scoped path — POST
// /rentals/608456/images/{unit-level image id}/downloadrequests 404s with
// "No image found with the id", even though that exact image id is real and
// listed by fetchUnitImages() above. The image belongs to a different path
// scope (/rentals/units/{unitId}/images/{imageId}/downloadrequests, which
// does return 201 + a real signed URL for the same id) — Buildium's rental
// images are scoped by whichever parent (property or unit) they were
// fetched under, not globally addressable by image id alone. This is why
// downloadUnitImage below is a separate function/path, not a shared one
// with an optional param — passing the wrong scope silently 404s rather
// than downloading the wrong thing, but only if callers use the function
// matching where the image id came from.
async function downloadImageByRequestPath(
  requestPath: string,
  buildiumImageId: number,
  contextLabel: string
): Promise<{ bytes: Buffer; contentType: string | null }> {
  const meta = (await buildiumPostRaw(requestPath)) as { DownloadUrl?: string };
  if (!meta.DownloadUrl) {
    throw new BuildiumApiError(
      `Buildium image ${buildiumImageId} (${contextLabel}) download request did not return a DownloadUrl`,
      502,
      JSON.stringify(meta)
    );
  }
  const fileRes = await fetch(meta.DownloadUrl);
  if (!fileRes.ok) {
    throw new BuildiumApiError(`Failed to download Buildium image ${buildiumImageId}`, fileRes.status, "");
  }
  const contentType = fileRes.headers.get("content-type");
  const arrayBuffer = await fileRes.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);

  // Reject anything that isn't recognizably an image BEFORE it reaches the
  // caller — this is the fix for the property 53 silent-corruption bug.
  // Checked here (once, shared by both downloadPropertyImage and
  // downloadUnitImage below) so every current and future caller gets this
  // for free, per Jason's no-duplicated-validation-logic rule.
  if (!detectImageFormat(bytes)) {
    throw new BuildiumApiError(
      `Buildium image ${buildiumImageId} (${contextLabel}) did not download as real image bytes — got ` +
        `${bytes.length} bytes, declared content-type "${contentType ?? "none"}", first bytes: ` +
        `${bytes.subarray(0, 16).toString("hex")}. This usually means the signed download URL returned an ` +
        `error/login page instead of the photo (e.g. an expired request).`,
      fileRes.status,
      bytes.subarray(0, 500).toString("utf8")
    );
  }

  return { bytes, contentType };
}

export async function downloadPropertyImage(
  buildiumPropertyId: number,
  buildiumImageId: number
): Promise<{ bytes: Buffer; contentType: string | null }> {
  return downloadImageByRequestPath(
    `/rentals/${buildiumPropertyId}/images/${buildiumImageId}/downloadrequests`,
    buildiumImageId,
    `property ${buildiumPropertyId}`
  );
}

// Companion to fetchUnitImages() — see the CONFIRMED LIVE note above for why
// this needs its own unit-scoped download path rather than reusing
// downloadPropertyImage with the image's property id.
export async function downloadUnitImage(
  buildiumUnitId: number,
  buildiumImageId: number
): Promise<{ bytes: Buffer; contentType: string | null }> {
  return downloadImageByRequestPath(
    `/rentals/units/${buildiumUnitId}/images/${buildiumImageId}/downloadrequests`,
    buildiumImageId,
    `unit ${buildiumUnitId}`
  );
}
