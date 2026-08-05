// LeadSimple mirror for sent 14-Day Notices — Jason's explicit division of
// labor: Buildium is the source of truth for balances/delinquency, and
// LeadSimple is where the communication RECORD lives, using only structures
// that already exist in his account. Discovered live against the real API
// (2026-08-03): tenants exist as Deals in the "Buildium Rental Tenants"
// pipeline with each co-tenant attached as a contact, so a sent notice is
// mirrored as (1) an outbound-email note on that Deal and (2) the notice
// PDF uploaded to the Deal's files. No new process types, pipelines,
// contacts, or mailboxes are ever created — if no matching Deal is found,
// the mirror is skipped and reported, never invented.
//
// The API (base https://api.leadsimple.com/rest, Authorization: Bearer):
//   GET  /deals?search=&pipeline_id=   — search matches contact name/email
//   POST /notes                        — formData: parent_id, parent_type
//                                        ('Deal'), description, kind
//                                        ('email'), direction ('outbound'),
//                                        created_at
//   POST /uploaded_files               — multipart: uploadable_id,
//                                        uploadable_type ('deals'), file
// Conversations can only be READ/tagged via this API, not created — notes
// with kind=email are LeadSimple's own representation for logged emails.
//
// Every function here throws on failure; the ONE caller (sendNotice.ts)
// wraps the whole mirror in a try/catch so a LeadSimple outage or a
// missing Deal can never block or fail an actual notice send. LeadSimple
// rate-limits per-minute (and has no retry logic anywhere in this codebase
// yet — see the pinned global-rate-limiter follow-up); this module keeps it
// to at most 1 search + 1 note + 1 upload per sent notice.
import { loadEnv } from "../config/env.js";
import { logInfo, logWarn } from "../lib/appLogger.js";

const LEADSIMPLE_BASE_URL = "https://api.leadsimple.com/rest";

interface LeadSimpleContact {
  name?: string;
  // The swagger spec declares this "string", but the REAL API returns an
  // array of email strings (confirmed live 2026-08-03) — accept both so a
  // future API normalization can't break the match.
  emails?: string | string[];
}

interface LeadSimpleDeal {
  id: string;
  name: string;
  pipeline?: { id?: string; name?: string };
  contacts?: LeadSimpleContact[] | LeadSimpleContact;
}

function contactEmails(contact: LeadSimpleContact): string[] {
  if (Array.isArray(contact.emails)) return contact.emails;
  if (typeof contact.emails === "string" && contact.emails.length > 0) return [contact.emails];
  return [];
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

// Finds the tenant's Deal in the Buildium Rental Tenants pipeline by
// searching each recipient email until one matches. The pipeline_id filter
// is passed to the API, and the pipeline is ALSO re-checked on the response
// (belt and suspenders — the same tenant usually has a second Deal in the
// "New Applicant" pipeline from before they signed, which must never
// receive collections notes). Returns null when nothing matches.
export async function findTenantDealId(recipientEmails: string[]): Promise<{ dealId: string; dealName: string } | null> {
  const env = loadEnv();
  if (!env.LEADSIMPLE_API_KEY) return null;

  for (const email of recipientEmails) {
    const url = `${LEADSIMPLE_BASE_URL}/deals?search=${encodeURIComponent(email)}&pipeline_id=${encodeURIComponent(env.LEADSIMPLE_TENANTS_PIPELINE_ID)}&per_page=10`;
    const res = await fetch(url, { headers: authHeaders(env.LEADSIMPLE_API_KEY), signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      throw new Error(`LeadSimple deal search failed: ${res.status} ${await res.text().catch(() => "<no body>")}`);
    }
    const body = (await res.json()) as { data?: LeadSimpleDeal[] };
    for (const deal of body.data ?? []) {
      if (deal.pipeline?.id && deal.pipeline.id !== env.LEADSIMPLE_TENANTS_PIPELINE_ID) continue;
      const contacts = Array.isArray(deal.contacts) ? deal.contacts : deal.contacts ? [deal.contacts] : [];
      const hasEmail = contacts.some((c) => contactEmails(c).some((e) => e.toLowerCase() === email.toLowerCase()));
      if (hasEmail) {
        return { dealId: deal.id, dealName: deal.name };
      }
    }
  }
  return null;
}

// user_id ("User to assign the note activity to") is optional per
// LeadSimple's own POST /notes spec. Omitted (not sent as an empty
// string) when null, matching the pre-fix behavior exactly for any PM
// with no known LeadSimple account — LeadSimple's own default
// attribution (the API key owner) applies, same as before this fix.
async function createOutboundEmailNote(
  dealId: string,
  description: string,
  sentAtIso: string,
  userId: string | null
): Promise<void> {
  const env = loadEnv();
  const form = new URLSearchParams({
    parent_id: dealId,
    parent_type: "Deal",
    description,
    kind: "email",
    direction: "outbound",
    created_at: sentAtIso,
    ...(userId ? { user_id: userId } : {}),
  });
  const res = await fetch(`${LEADSIMPLE_BASE_URL}/notes`, {
    method: "POST",
    headers: { ...authHeaders(env.LEADSIMPLE_API_KEY!), "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`LeadSimple note create failed: ${res.status} ${await res.text().catch(() => "<no body>")}`);
  }
}

async function uploadDealPdf(dealId: string, filename: string, pdf: Buffer): Promise<void> {
  const env = loadEnv();
  const form = new FormData();
  form.append("uploadable_id", dealId);
  form.append("uploadable_type", "deals");
  // public_access deliberately omitted (defaults false) — a legal notice
  // PDF must never be downloadable by unauthenticated users.
  form.append("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), filename);
  const res = await fetch(`${LEADSIMPLE_BASE_URL}/uploaded_files`, {
    method: "POST",
    headers: authHeaders(env.LEADSIMPLE_API_KEY!),
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`LeadSimple file upload failed: ${res.status} ${await res.text().catch(() => "<no body>")}`);
  }
}

export interface NoticeMirrorPayload {
  noticeId: number;
  recipientEmails: string[];
  recipientNames: string[];
  subject: string;
  amountDue: string; // already formatted, e.g. "$1,875.50"
  deliveryStatus: string; // 'sent' | 'bounced'
  sentByPmName: string;
  // Real fix (2026-08-05) for notes always showing as posted by the
  // LeadSimple API key's owner regardless of who actually sent the
  // notice — see pm_users.leadsimple_user_id (migration 0052). Null when
  // the sending PM has no known LeadSimple account; the note still posts,
  // just under LeadSimple's own default attribution as before.
  sentByLeadSimpleUserId: string | null;
  sentAtIso: string;
  pdf: Buffer;
  pdfFilename: string;
}

export interface NoticeMirrorResult {
  mirrored: boolean;
  dealId?: string;
  dealName?: string;
  skippedReason?: string;
}

// Mirrors one real sent notice to LeadSimple. Throws on API failure (caller
// catches); returns mirrored:false with a reason for the two non-error
// skip cases (integration not configured, or no matching tenant Deal).
export async function mirrorNoticeToLeadSimple(payload: NoticeMirrorPayload): Promise<NoticeMirrorResult> {
  const env = loadEnv();
  if (!env.LEADSIMPLE_API_KEY) {
    logInfo("LeadSimple mirror skipped: LEADSIMPLE_API_KEY not configured", { noticeId: payload.noticeId });
    return { mirrored: false, skippedReason: "not_configured" };
  }

  const deal = await findTenantDealId(payload.recipientEmails);
  if (!deal) {
    // Real, actionable signal — the notice DID go out but LeadSimple has no
    // matching tenant Deal to record it on (e.g. tenant not synced into the
    // Buildium Rental Tenants pipeline). Logged loudly, never fabricated.
    logWarn("LeadSimple mirror skipped: no matching Deal in Buildium Rental Tenants pipeline", {
      noticeId: payload.noticeId,
    });
    return { mirrored: false, skippedReason: "no_matching_deal" };
  }

  const description =
    `${payload.subject}\n\n` +
    `14-Day Notice of Default emailed to ${payload.recipientNames.join(", ")} ` +
    `(${payload.recipientEmails.join(", ")}). Total due ${payload.amountDue}. ` +
    `Sent by ${payload.sentByPmName} via the Late Rent Notices system. ` +
    `Delivery status: ${payload.deliveryStatus}. ` +
    `The notice PDF is attached to this deal's files as "${payload.pdfFilename}".`;

  await createOutboundEmailNote(deal.dealId, description, payload.sentAtIso, payload.sentByLeadSimpleUserId);
  await uploadDealPdf(deal.dealId, payload.pdfFilename, payload.pdf);

  logInfo("LeadSimple mirror complete", { noticeId: payload.noticeId, dealId: deal.dealId });
  return { mirrored: true, dealId: deal.dealId, dealName: deal.dealName };
}
