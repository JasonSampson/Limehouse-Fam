import type { LeadSimpleProcess } from "../leadsimple/client.js";
import type { BuildiumLease, BuildiumProperty } from "../buildium/client.js";
import { getCachedMetric } from "../db/metricCache.js";

// Terminated Properties — ADDED 2026-07-10, per Jason directly. Some
// properties stay on Buildium's active roster (IsActive still true) long
// after the owner relationship has effectively ended — outstanding bills
// need to settle before Buildium closes them out — and until then they
// count as ordinary vacant units on every occupancy/vacancy tile, dragging
// those numbers down for something that isn't a real vacancy anymore.
// Two real examples confirmed live: 3400 Landstown Court, 300 Garrison
// Place.
//
// No Buildium field distinguishes this (custom fields aren't exposed via
// their API at all — confirmed by direct probing, 404 on every plausible
// endpoint, and absent from their full published API reference). The real
// signal instead comes from LeadSimple's "07 Lease Renewal Process" —
// Jason's team already moves a property's renewal process to one of two
// real stages when the owner isn't renewing through Limehouse anymore:
// "Owner Terminating Management" or "Owner Selling Property" (a third
// stage, "Owner Relisting", means the OPPOSITE — Limehouse is actively
// re-marketing it — and is deliberately excluded here).
const TERMINAL_STAGE_NAMES = new Set(["Owner Terminating Management", "Owner Selling Property"]);

export interface TerminatingCandidate {
  address: string;
  stage: string;
  terminatedAt: string; // ISO date-time (closed_at, falling back to updated_at)
}

// For each property address, finds its MOST RECENT Lease Renewal process
// (any stage) and keeps it only if that latest process is one of the two
// terminal "not renewing through us" stages. A property whose latest
// process is something else — still in progress, or actually renewed —
// is not a candidate, even if an OLDER process on the same address was
// terminal once: the latest decision wins (e.g. 3400 Landstown Court has
// 3 historical processes; only the most recent, "Owner Selling Property",
// matters).
export function findTerminatingCandidates(processes: LeadSimpleProcess[]): Map<string, TerminatingCandidate> {
  const latestByAddress = new Map<string, { stage: string; sortKey: string }>();
  for (const p of processes) {
    if (!p.stage || p.properties.length === 0) continue;
    const address = p.properties[0].address;
    if (!address) continue;
    const sortKey = p.closed_at ?? p.updated_at;
    const existing = latestByAddress.get(address);
    if (!existing || sortKey > existing.sortKey) {
      latestByAddress.set(address, { stage: p.stage.name, sortKey });
    }
  }

  const candidates = new Map<string, TerminatingCandidate>();
  for (const [address, { stage, sortKey }] of latestByAddress.entries()) {
    if (TERMINAL_STAGE_NAMES.has(stage)) {
      candidates.set(address, { address, stage, terminatedAt: sortKey });
    }
  }
  return candidates;
}

export interface TerminatedPropertyExclusion {
  propertyId: string;
  address: string;
  stage: string;
  terminatedAt: string;
}

// Matches candidate addresses to real, CURRENTLY-ACTIVE Buildium
// properties — a candidate whose property has already gone fully inactive
// in Buildium doesn't need excluding here, it's already out of every
// count on its own.
export function matchCandidatesToActiveProperties(
  candidates: Map<string, TerminatingCandidate>,
  activeProperties: BuildiumProperty[]
): TerminatedPropertyExclusion[] {
  const results: TerminatedPropertyExclusion[] = [];
  for (const property of activeProperties) {
    const address = property.Address?.AddressLine1;
    if (!address) continue;
    const candidate = candidates.get(address);
    if (!candidate) continue;
    results.push({ propertyId: String(property.Id), address, stage: candidate.stage, terminatedAt: candidate.terminatedAt });
  }
  return results;
}

// A candidate property is STILL genuinely excluded only if nothing since
// the termination decision shows it came back under active management —
// per Jason directly (2026-07-10): either a real lease (any status)
// starting after the decision, or an Owner Onboarding Fee transaction
// posted after it (the real trigger for marketing to restart — confirmed
// against 724 Carolina Avenue, whose 2024 termination was superseded by a
// fee paid 2026-06-29 and a new lease starting 2026-08-01, over a month
// later; the fee is the earlier of the two real signals).
export function isStillExcluded(terminatedAt: string, leasesForProperty: BuildiumLease[], onboardingFeeDate: string | null): boolean {
  const terminatedDate = terminatedAt.slice(0, 10);
  const hasNewerLease = leasesForProperty.some((l) => l.LeaseFromDate !== null && l.LeaseFromDate > terminatedDate);
  if (hasNewerLease) return false;
  if (onboardingFeeDate !== null && onboardingFeeDate > terminatedDate) return false;
  return true;
}

// Shared read side of the exclusion — ADDED 2026-07-10, moved here from
// dashboardRoutes.ts so CEO View and Team Performance can reuse the exact
// same set instead of each re-deriving it. Reads the cache
// POST /api/sync/terminated-properties writes. Returns an empty set, never
// throws, if the sync hasn't run yet — every caller filters units by this
// set BEFORE handing them to whatever occupancy/revenue/KPI function they
// already use, so none of those functions themselves need to change.
export async function getExcludedPropertyIds(): Promise<Set<string>> {
  const cached = await getCachedMetric("terminated_properties", "portfolio");
  if (!cached || cached.value === null) return new Set();
  const value = cached.value as { excluded: Array<{ propertyId: string }> };
  return new Set(value.excluded.map((e) => e.propertyId));
}
