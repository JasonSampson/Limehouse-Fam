import { describe, it, expect } from "vitest";
import { formatUnitDisplay } from "../../src/lib/unitDisplay.js";
import { formatDateMMDDYYYY } from "../../src/templates/renderTemplate.js";

// Jason's display rules (2026-08-04): units read "Unit B2" at multi-unit
// properties; a single-family house shows no unit at all, because
// Buildium's obligatory unit "1" doesn't mean anything there. Dates read
// MM/DD/YYYY everywhere a person sees them.
describe("formatUnitDisplay", () => {
  it('prefixes "Unit" at a multi-unit property', () => {
    expect(formatUnitDisplay("B2", true)).toBe("Unit B2");
  });

  it('shows "Unit 1" at a multi-unit property whose first unit is literally labeled 1 (e.g. 9635 Salem Street)', () => {
    expect(formatUnitDisplay("1", true)).toBe("Unit 1");
  });

  it('hides Buildium\'s obligatory "1" at a single-family house', () => {
    expect(formatUnitDisplay("1", false)).toBe("");
  });

  it("still shows a meaningful non-1 label even when the property has a single unit", () => {
    expect(formatUnitDisplay("Carriage House", false)).toBe("Unit Carriage House");
  });

  it("returns empty for a blank label", () => {
    expect(formatUnitDisplay("", true)).toBe("");
    expect(formatUnitDisplay("  ", false)).toBe("");
  });
});

describe("formatDateMMDDYYYY", () => {
  it("formats a UTC date as MM/DD/YYYY with zero padding", () => {
    expect(formatDateMMDDYYYY(new Date("2026-08-01T00:00:00Z"))).toBe("08/01/2026");
    expect(formatDateMMDDYYYY(new Date("2026-12-25T00:00:00Z"))).toBe("12/25/2026");
  });

  it("uses UTC parts so a due date computed at UTC midnight never drifts a day in local time", () => {
    // 11 PM Eastern on 8/3 is already 8/4 UTC — the due-date math works in
    // UTC, so the formatter must too.
    expect(formatDateMMDDYYYY(new Date("2026-08-04T03:00:00Z"))).toBe("08/04/2026");
  });
});
