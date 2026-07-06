import type { BuildiumProperty, BuildiumUnit, LeaseBalance } from "../buildium/client.js";

// Property Health breakdown (Occupancy & Doors section). CONFIRMED
// 2026-07-03: this is NOT a stored field anywhere in Buildium — Oracle's
// research found nothing matching Healthy/At-risk/Waitlist/On Hold/
// Off-Market/Commercial/Unknown on any real property record. It's a
// computed classification, confirmed against the real vendor site's own
// on-screen legend: "Healthy = occupied · At-risk = delinquent ·
// Off-Market = vacant." Categorized PER PROPERTY (not per unit) — the
// vendor site's ~31-ish category total maps to property count, and this
// account's real confirmed active-property count is 201 (200 Residential
// + 1 Commercial), not the 233-unit figure used elsewhere on this
// dashboard.
//
// Priority order (a property can only land in ONE category, checked in
// this order — e.g. a fully-vacant Commercial property is Off-Market, not
// Commercial, since "is anyone home" is the more urgent signal for a PM):
//   1. Off-Market  — zero occupied units (fully vacant property)
//   2. At-risk     — at least one lease on the property is delinquent
//   3. Commercial  — RentalType/RentalSubType indicates non-residential
//   4. Healthy     — occupied and not delinquent (the default good state)
//   5. Unknown     — doesn't confidently match any of the above
//
// Waitlist and On Hold are NOT implemented: no real Buildium field
// evidence surfaced for either category during research, and per the
// coordinator's explicit instruction, a property is routed to Unknown
// rather than guessed into one of these two. This is a real, honest gap —
// not a bug — and should stay that way until a real field/signal for
// Waitlist or On Hold is identified (e.g. Jason confirms these come from
// somewhere else entirely, like Property Meld or LeadSimple).
export type PropertyHealthCategory =
  | "Healthy"
  | "At-risk"
  | "Waitlist"
  | "On Hold"
  | "Off-Market"
  | "Commercial"
  | "Unknown";

export interface PropertyHealthRow {
  propertyId: string;
  category: PropertyHealthCategory;
}

export interface PropertyHealthSummary {
  totalProperties: number;
  countsByCategory: Record<PropertyHealthCategory, number>;
}

const RESIDENTIAL_SUBTYPES = new Set(["SingleFamily", "MultiFamily", "CondoTownhome"]);

export function classifyPropertyHealth(
  properties: BuildiumProperty[],
  unitsByPropertyId: Map<string, BuildiumUnit[]>,
  delinquentBalances: LeaseBalance[]
): PropertyHealthRow[] {
  const delinquentPropertyIds = new Set(delinquentBalances.filter((b) => b.balance > 0).map((b) => b.propertyId));

  return properties.map((property) => {
    const propertyId = String(property.Id);
    const units = unitsByPropertyId.get(propertyId) ?? [];

    const category = classifyOneProperty(property, units, delinquentPropertyIds.has(propertyId));
    return { propertyId, category };
  });
}

function classifyOneProperty(
  property: BuildiumProperty,
  units: BuildiumUnit[],
  isDelinquent: boolean
): PropertyHealthCategory {
  // A property with zero unit records at all is a data gap, not a
  // confident "fully vacant" signal — route to Unknown rather than
  // guessing Off-Market from an absence of data.
  if (units.length === 0) return "Unknown";

  const occupiedUnitCount = units.filter((u) => u.IsUnitOccupied).length;

  if (occupiedUnitCount === 0) return "Off-Market";
  if (isDelinquent) return "At-risk";

  // RentalType is nullable on the real schema; a null/unexpected value
  // here is a gap, not evidence of Commercial, so it falls through to the
  // Healthy/Unknown check below instead of being misclassified.
  const isResidential =
    property.RentalType === "Residential"; // confirmed live: RentalSubType further splits into SingleFamily/MultiFamily/CondoTownhome, all residential
  const isKnownNonResidential = property.RentalType !== null && property.RentalType !== "Residential";
  if (isKnownNonResidential) return "Commercial";

  if (isResidential) return "Healthy";

  return "Unknown";
}

export function summarizePropertyHealth(rows: PropertyHealthRow[]): PropertyHealthSummary {
  const countsByCategory: Record<PropertyHealthCategory, number> = {
    Healthy: 0,
    "At-risk": 0,
    Waitlist: 0,
    "On Hold": 0,
    "Off-Market": 0,
    Commercial: 0,
    Unknown: 0,
  };

  for (const row of rows) {
    countsByCategory[row.category]++;
  }

  return { totalProperties: rows.length, countsByCategory };
}
