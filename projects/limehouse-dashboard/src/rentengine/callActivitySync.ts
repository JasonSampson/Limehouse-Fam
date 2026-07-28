import { fetchProspects, fetchCallsForProspect, fetchMessagesForProspect } from "./client.js";
import { logInfo, logWarn } from "../lib/logger.js";

// Total Calls / Outbound Texts (Marketing & Showings section) require
// RentEngine's /calls and /messages endpoints — CONFIRMED LIVE 2026-07-03
// these require ONE call per prospect (prospect_id + account_ids), with no
// bulk/account-wide variant, against a confirmed 30 req/min rate limit
// (X-Ratelimit-Limit response header). This account has 3,771 total
// prospects — fetching call/message activity for all of them, one at a
// time, respecting the rate limit, would take roughly 2+ hours for calls
// alone (and another 2+ for messages). That is not something any API route
// can do on a page-load path; it has to be a background sync.
//
// SCOPED, not exhaustive: rather than syncing all 3,771 prospects ever
// created, this syncs only prospects CREATED within the requested date
// window (the sync caller passes the same period the dashboard tile is
// asking about) — call/message activity tiles are period-scoped anyway
// (Total Calls "this month", etc.), so there's no need to re-fetch call
// history for a prospect from 5 months ago when computing "this month"'s
// totals. This keeps a single sync run bounded to whatever prospect
// volume actually falls in the requested window (tens to low hundreds per
// month for this account, not thousands), well within the rate limit.
//
// A caller needing "the trailing 12 months" runs this once per month
// snapshot going forward (see the "start snapshotting today" pattern
// noted throughout this build) rather than one giant historical backfill
// that would take hours and hammer the rate limit for data Jason may not
// even need broken out by month.
const RENTENGINE_ACCOUNT_ID_MIN_LENGTH = 10; // sanity check only — real account_id is a UUID

export interface CallActivitySyncResult {
  prospectsScanned: number;
  totalCalls: number;
  outboundTexts: number;
  errors: number;
}

// REMOVED 2026-07-28, per Jason directly: this job used to space its own
// requests by hand (DELAY_BETWEEN_PROSPECTS_MS, 4.2s between prospects) to
// stay under RentEngine's real 30 req/min limit — but that only protected
// THIS call site. rentEngineGet now routes every RentEngine call in the
// whole app through one shared global spacer (see
// src/lib/globalRequestLimiter.ts), so the same protection applies here
// automatically, AND to every other RentEngine caller that never had any
// spacing of its own (fetchProspects, fetchUnits, fetchLeasingPerformanceForUnit,
// etc.) — a real gap this job's own hand-rolled fix never covered.

export async function syncCallActivityForPeriod(
  fromDate: string,
  toDate: string,
  accountId: string
): Promise<CallActivitySyncResult> {
  if (accountId.length < RENTENGINE_ACCOUNT_ID_MIN_LENGTH) {
    throw new Error(`RentEngine account_id looks malformed: "${accountId}"`);
  }

  const prospectsResult = await fetchProspects(fromDate, toDate);
  if (!prospectsResult.connected) {
    throw new Error("RentEngine is not connected — cannot sync call activity.");
  }
  if (prospectsResult.error || !prospectsResult.data) {
    throw new Error(`Failed to fetch prospects for call activity sync: ${prospectsResult.error}`);
  }

  const prospects = prospectsResult.data;
  let totalCalls = 0;
  let outboundTexts = 0;
  let errors = 0;

  for (const prospect of prospects) {
    try {
      const [calls, messages] = await Promise.all([
        fetchCallsForProspect(prospect.id, accountId),
        fetchMessagesForProspect(prospect.id, accountId),
      ]);
      totalCalls += calls.length;
      // "Outbound" per the tile name — only count messages this account
      // sent, not inbound replies. direction is an optional/loosely-typed
      // field on the real response (see client.ts); a message with no
      // direction field at all is excluded rather than assumed outbound,
      // so an unexpected/missing value undercounts instead of
      // overclaiming outreach volume.
      outboundTexts += messages.filter((m) => m.direction === "outbound").length;
    } catch (err) {
      errors++;
      logWarn("Call/message fetch failed for prospect during sync", {
        prospectId: prospect.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logInfo("RentEngine call activity sync completed", {
    prospectsScanned: prospects.length,
    totalCalls,
    outboundTexts,
    errors,
  });

  return { prospectsScanned: prospects.length, totalCalls, outboundTexts, errors };
}
