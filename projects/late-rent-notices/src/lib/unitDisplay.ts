// How a unit label reads to a human — Jason's rule (2026-08-04): at a
// multi-unit property the unit matters and reads as "Unit B2"; at a
// single-family house Buildium's obligatory unit "1" is noise ("a single
// family home doesn't have units") and shows nothing at all.
//
// "Multi-unit" is decided from the data — does the property have more than
// one distinct unit among its leases — not from the label itself, because
// a real multi-unit building's first unit is often literally labeled "1"
// (e.g. 9635 Salem Street's five units) and must still display. The one
// ambiguous case, a genuinely multi-unit building where only one unit has
// ever had a lease synced, falls back to hiding a bare "1" — the same
// harmless direction as a single-family home.
//
// Callers pass multiUnit from SQL:
//   (SELECT count(DISTINCT l2.unit_buildium_id) FROM leases l2
//     WHERE l2.property_id = l.property_id) > 1 AS multi_unit
export function formatUnitDisplay(unitLabel: string, multiUnit: boolean): string {
  const label = (unitLabel ?? "").trim();
  if (label.length === 0) return "";
  if (!multiUnit && label === "1") return "";
  return `Unit ${label}`;
}
