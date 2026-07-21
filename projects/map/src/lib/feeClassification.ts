// Shared classifier for whether a recurring charge's human-entered label
// should be excluded from the map popup display. Jason's call (2026-07-21):
// "Resident Benefits Package" reads as a background admin fee, not a housing
// cost like rent/utilities, and must never display alongside rent.
//
// ONE function, called identically by src/buildium/sync.ts and
// src/rentengine/sync.ts, per Jason's standing rule against duplicating
// filter/validation logic across files. Confirmed live that the label
// wording is NOT stable across leases/listings for the same real-world
// charge — e.g. "Resident Benefits Package" vs "Resident Benefit Package"
// (singular/plural) — so this matches case-insensitively on the stable
// substring "resident benefit", not an exact string, and tolerates
// punctuation/whitespace noise around it.
//
// REAL LIVE GAP FOUND BY TARS (2026-07-21): a full portfolio scan of all
// 311 real synced charge rows found one the phrase pattern above misses —
// lease 2719289 (5064 Heathglen Circle Unit 1) has this exact fee labeled
// just "RBP" ($45.95/mo, same signature as every confirmed spelled-out
// row), which slipped through and displayed on the live map. The same full
// scan found no OTHER unrecognized variant across all 311 rows (every other
// label is a genuine, different real charge — Pet Rent, Utility Rent,
// Water/Sewer/Trash in various wordings) — so rather than guessing at
// abbreviations that have no evidence of existing (e.g. "RB Pkg"), this
// adds the one abbreviation actually confirmed live, matched as a whole
// word (\b) so it can't accidentally match as a substring inside some
// other label. If a future portfolio scan turns up another unrecognized
// variant, add it here the same way — don't pre-guess ones with no real
// example.
const EXCLUDED_LABEL_PATTERNS: RegExp[] = [
  /resident\s+benefits?\s+package/i,
  /\bRBP\b/i,
];

export function isExcludedFromDisplay(label: string): boolean {
  return EXCLUDED_LABEL_PATTERNS.some((pattern) => pattern.test(label));
}
