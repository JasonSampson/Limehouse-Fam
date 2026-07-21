// Address-based matching between RentEngine listings and Buildium
// properties/units.
//
// Per Jason directly (2026-07-20/21): neither he nor his team ever sees or
// uses a RentEngine listing id as a link back to Buildium — the property
// ADDRESS is the only thing both systems agree on, so that's the only
// matching key this file uses. RentEngine's own numeric id has no
// relationship to Buildium's ids (confirmed separately, see Dashboard's
// client.ts) and schema.md's "extracted_from URL id" lead was a possible
// alternative but is NOT what this build uses, per that direct
// confirmation — address matching only.
//
// CONFIRMED LIVE 2026-07-21 against Jason's real RentEngine account (70
// real /units records) cross-checked against real `map.properties` rows:
//   - Same real building, different listings, spelled differently by
//     RentEngine itself: "9117 Chesapeake Blvd #5" vs "9117 Chesapeake
//     Boulevard #4" (Buildium's own address_line1 for that property is
//     "9117 Chesapeake Boulevard").
//   - Same real building: "2642 E Ocean View Ave #B4" vs "2642 East Ocean
//     View Avenue #B1" (Buildium: "2642 East Ocean View Avenue").
//   - Multi-unit buildings confirmed live: RentEngine's `unit` field
//     ("B4", "A1", "4", "5", "201"...) matches Buildium's `units.unit_label`
//     values exactly once both sides are normalized the same way.
//
// Deliberately NOT a full USPS-grade address parser — just enough
// normalization to close the real gaps above: street-type abbreviation vs
// spelled-out, directional abbreviation vs spelled-out, and a unit suffix
// written differently ("#5" / "Apt 5" / "Unit 5"). Anything this doesn't
// confidently resolve to exactly one property (and, for a multi-unit
// property, exactly one unit) is NO MATCH — never a best guess. A wrong
// asking rent shown against the wrong property is worse than showing
// nothing (see sync.ts for how a non-match gets surfaced, never silently
// dropped).

const STREET_TYPE_MAP: Record<string, string> = {
  street: "st",
  st: "st",
  avenue: "ave",
  ave: "ave",
  boulevard: "blvd",
  blvd: "blvd",
  drive: "dr",
  dr: "dr",
  court: "ct",
  ct: "ct",
  lane: "ln",
  ln: "ln",
  road: "rd",
  rd: "rd",
  place: "pl",
  pl: "pl",
  parkway: "pkwy",
  pkwy: "pkwy",
  square: "sq",
  sq: "sq",
  circle: "cir",
  cir: "cir",
  terrace: "ter",
  ter: "ter",
  trail: "trl",
  trl: "trl",
  highway: "hwy",
  hwy: "hwy",
};

const DIRECTIONAL_MAP: Record<string, string> = {
  north: "n",
  n: "n",
  south: "s",
  s: "s",
  east: "e",
  e: "e",
  west: "w",
  w: "w",
  northeast: "ne",
  ne: "ne",
  northwest: "nw",
  nw: "nw",
  southeast: "se",
  se: "se",
  southwest: "sw",
  sw: "sw",
};

function normalizeWord(word: string): string {
  return STREET_TYPE_MAP[word] ?? DIRECTIONAL_MAP[word] ?? word;
}

// Lowercases, strips punctuation, and maps each word through the
// street-type/directional abbreviation table above so "East Ocean View
// Avenue" and "E Ocean View Ave" normalize to the same string.
export function normalizeStreetName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeWord)
    .join(" ")
    .trim();
}

export function normalizeCity(raw: string): string {
  return raw.toLowerCase().replace(/[.,]/g, "").trim();
}

// Strips a leading house/street number (keeping a letter suffix like
// "42B") and returns the number plus the rest of the string. Confirmed
// live this covers every real Buildium address_line1 and RentEngine
// street-name pairing seen — always number-then-name.
export function splitStreetNumber(addressLine: string): { streetNumber: string | null; rest: string } {
  const match = addressLine.trim().match(/^(\d+[A-Za-z]?)\s+(.*)$/);
  if (!match) return { streetNumber: null, rest: addressLine.trim() };
  return { streetNumber: match[1].toLowerCase(), rest: match[2] };
}

// Fallback unit-suffix extraction ("#5", "Apt 5", "Unit 5", "Suite 5") —
// used ONLY when a caller has just a single formatted-address string.
// RentEngine's real /units response already separates the unit into its
// own field (see client.ts) and should be used directly instead.
const UNIT_MARKER_RE = /(?:#|(?:apt|apartment|unit|suite|ste)\.?\s*)\s*([a-z0-9-]+)\s*$/i;

export function extractUnitSuffix(text: string): { streetPart: string; unit: string | null } {
  const match = text.match(UNIT_MARKER_RE);
  if (!match || match.index === undefined) return { streetPart: text.trim(), unit: null };
  return { streetPart: text.slice(0, match.index).trim(), unit: match[1] };
}

// Normalizes a unit label from either side ("Unit 201" / "201", "#B4" /
// "B4") down to a bare comparable token.
export function normalizeUnitLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/^(apt|apartment|unit|suite|ste)\.?\s*/i, "")
    .replace(/^#/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export interface PropertyRow {
  id: number;
  address_line1: string;
  address_line2: string | null;
  city: string;
}

export interface UnitRow {
  id: number;
  unit_label: string;
}

export interface RentEngineAddressInput {
  streetNumber: string | null;
  streetName: string | null;
  unit: string | null;
  city: string | null;
  formattedAddress: string | null;
}

export type PropertyMatchStatus = "matched" | "no_candidates" | "ambiguous";

export interface PropertyMatchResult {
  status: PropertyMatchStatus;
  property: PropertyRow | null;
}

// Matches a RentEngine listing's address to exactly one Buildium property.
// Prefers the structured streetNumber/streetName fields RentEngine's real
// /units response already provides; falls back to parsing
// formattedAddress only if those are missing.
export function matchProperty(reAddress: RentEngineAddressInput, properties: PropertyRow[]): PropertyMatchResult {
  let streetNumber = reAddress.streetNumber;
  let streetName = reAddress.streetName;
  if ((!streetNumber || !streetName) && reAddress.formattedAddress) {
    const { streetPart } = extractUnitSuffix(reAddress.formattedAddress);
    const split = splitStreetNumber(streetPart);
    streetNumber = streetNumber ?? split.streetNumber;
    streetName = streetName ?? split.rest;
  }
  if (!streetNumber || !streetName) {
    return { status: "no_candidates", property: null };
  }

  const normalizedNumber = streetNumber.toLowerCase();
  const normalizedName = normalizeStreetName(streetName);
  const normalizedCity = reAddress.city ? normalizeCity(reAddress.city) : null;

  const candidates = properties.filter((p) => {
    const split = splitStreetNumber(p.address_line1);
    if (!split.streetNumber || split.streetNumber !== normalizedNumber) return false;
    if (normalizeStreetName(split.rest) !== normalizedName) return false;
    if (normalizedCity && normalizeCity(p.city) !== normalizedCity) return false;
    return true;
  });

  if (candidates.length === 1) return { status: "matched", property: candidates[0] };
  if (candidates.length === 0) return { status: "no_candidates", property: null };
  return { status: "ambiguous", property: null };
}

export type UnitMatchStatus = "matched" | "not_needed" | "no_candidates" | "ambiguous";

export interface UnitMatchResult {
  status: UnitMatchStatus;
  unit: UnitRow | null;
}

// Once a property is matched, resolves WHICH of its units the listing is
// for. A property with exactly one unit is unambiguous regardless of
// whether RentEngine reported a unit label ("not_needed"). A property with
// more than one unit REQUIRES a matching unit label — this never guesses
// which of several units a unit-less listing refers to.
export function matchUnit(reUnit: string | null, units: UnitRow[]): UnitMatchResult {
  if (units.length === 0) return { status: "no_candidates", unit: null };
  if (units.length === 1) return { status: "not_needed", unit: units[0] };

  const normalizedReUnit = normalizeUnitLabel(reUnit);
  if (!normalizedReUnit) return { status: "ambiguous", unit: null };

  const candidates = units.filter((u) => normalizeUnitLabel(u.unit_label) === normalizedReUnit);
  if (candidates.length === 1) return { status: "matched", unit: candidates[0] };
  if (candidates.length === 0) return { status: "no_candidates", unit: null };
  return { status: "ambiguous", unit: null };
}
