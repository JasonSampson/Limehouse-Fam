import { describe, it, expect } from "vitest";
import { roleDisplayName, allKnownRoles, knownRolesForDisplayGroup } from "../../src/db/kpiRepository.js";

// Regression coverage for the live bug found 2026-07-03: getScoredRoles()
// used to build each role's display name from whichever KPI DEFINITION
// row happened to be iterated first (a per-KPI label like "Portfolio
// Occupancy Rate"), not a genuine role name — so the frontend's role-tab
// matching against that field NEVER succeeded, for any role, even though
// the API was returning fully correct scored data. This locks in the
// canonical slug -> display name mapping as the actual source of truth,
// independent of anything in the dashboard_kpi_definitions table.
describe("roleDisplayName (team_performance / default)", () => {
  it("maps all 6 known Limehouse roles to their correct human-readable name", () => {
    expect(roleDisplayName("portfolio_manager")).toBe("Portfolio Manager");
    expect(roleDisplayName("portfolio_assistant")).toBe("Portfolio Assistant");
    expect(roleDisplayName("bookkeeper")).toBe("Bookkeeper");
    expect(roleDisplayName("leasing_specialist")).toBe("Leasing Specialist");
    expect(roleDisplayName("marketing_specialist")).toBe("Marketing Specialist");
    expect(roleDisplayName("administrative_assistant")).toBe("Administrative Assistant");
  });

  it("resolves Marketing Specialist's display name even though it has zero KPI definition rows in the DB", () => {
    // Marketing Specialist is seeded with 0 rows in dashboard_kpi_definitions
    // on purpose (Neo's migration 0002 comment — RentEngine access is
    // blocked, nothing to score yet). roleDisplayName() must still resolve
    // its name correctly because the mapping lives in code, not in a KPI
    // row — there is no KPI row for this role to (mis)derive a label from.
    expect(roleDisplayName("marketing_specialist")).toBe("Marketing Specialist");
  });

  it("falls back to the raw slug for an unrecognized role rather than throwing", () => {
    // Guards against a future role being added to the DB before this map
    // is updated — the role's real scored data must still come through
    // (see getScoredRoles(), which never drops a role just because its
    // slug isn't in ROLE_DISPLAY_NAMES yet), just with a less pretty label
    // until the map catches up.
    expect(roleDisplayName("some_future_role")).toBe("some_future_role");
  });

  it("defaults to the team_performance name when no displayGroup is passed", () => {
    expect(roleDisplayName("portfolio_assistant")).toBe(roleDisplayName("portfolio_assistant", "team_performance"));
    expect(roleDisplayName("bookkeeper")).toBe(roleDisplayName("bookkeeper", "team_performance"));
  });
});

// Regression coverage for the SECOND live bug found 2026-07-03 (by Tron,
// while wiring the frontend against the first fix): the same role needs a
// DIFFERENT display name depending on which screen it's shown on. Confirmed
// against real captured vendor data — portfolio_assistant and bookkeeper
// are the only two roles that actually differ between the two screens;
// portfolio_manager renders the same name ("Portfolio Manager" / "PM") on
// both, so it correctly has no override entry.
describe("roleDisplayName (ceo_view overrides)", () => {
  it("portfolio_assistant resolves to 'Assistant Property Manager' under ceo_view but 'Portfolio Assistant' under team_performance", () => {
    expect(roleDisplayName("portfolio_assistant", "ceo_view")).toBe("Assistant Property Manager");
    expect(roleDisplayName("portfolio_assistant", "team_performance")).toBe("Portfolio Assistant");
  });

  it("bookkeeper resolves to 'Bookkeeping Coordinator' under ceo_view but 'Bookkeeper' under team_performance", () => {
    expect(roleDisplayName("bookkeeper", "ceo_view")).toBe("Bookkeeping Coordinator");
    expect(roleDisplayName("bookkeeper", "team_performance")).toBe("Bookkeeper");
  });

  it("portfolio_manager resolves to the SAME name on both screens (no override needed, matches real vendor data)", () => {
    expect(roleDisplayName("portfolio_manager", "ceo_view")).toBe("Portfolio Manager");
    expect(roleDisplayName("portfolio_manager", "team_performance")).toBe("Portfolio Manager");
  });

  it("a role with no ceo_view override falls back to its base (team_performance) name under ceo_view", () => {
    // leasing_specialist has no ceo_view override configured (it also isn't
    // in CEO_VIEW_ROLES at all — see knownRolesForDisplayGroup tests below
    // — but roleDisplayName() itself should still degrade gracefully rather
    // than throwing if ever called directly for this combination).
    expect(roleDisplayName("leasing_specialist", "ceo_view")).toBe("Leasing Specialist");
  });
});

describe("allKnownRoles", () => {
  it("lists exactly the 6 roles Limehouse has, including Marketing Specialist", () => {
    const roles = allKnownRoles();
    expect(roles).toHaveLength(6);
    expect(roles).toEqual(
      expect.arrayContaining([
        "portfolio_manager",
        "portfolio_assistant",
        "bookkeeper",
        "leasing_specialist",
        "marketing_specialist",
        "administrative_assistant",
      ])
    );
  });

  it("every role in the list resolves to a non-empty, distinct display name under team_performance", () => {
    const roles = allKnownRoles();
    const names = roles.map((r) => roleDisplayName(r, "team_performance"));
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length); // no two roles collide on the same display name
  });
});

// Regression coverage for the THIRD gap found alongside the display-name
// override bug: CEO View only ever had PM/APM/BC role-category rollups per
// the original spec — Leasing Specialist, Marketing Specialist, and
// Administrative Assistant must NOT be seeded as roles on that screen at
// all (doing so produced phantom always-empty cards that don't correspond
// to anything the real vendor site ever showed).
describe("knownRolesForDisplayGroup", () => {
  it("team_performance includes all 6 roles", () => {
    const roles = knownRolesForDisplayGroup("team_performance");
    expect(roles).toHaveLength(6);
    expect(roles).toEqual(expect.arrayContaining(allKnownRoles()));
  });

  it("ceo_view includes ONLY portfolio_manager, portfolio_assistant, and bookkeeper", () => {
    const roles = knownRolesForDisplayGroup("ceo_view");
    expect(roles).toHaveLength(3);
    expect(roles).toEqual(expect.arrayContaining(["portfolio_manager", "portfolio_assistant", "bookkeeper"]));
    expect(roles).not.toContain("leasing_specialist");
    expect(roles).not.toContain("marketing_specialist");
    expect(roles).not.toContain("administrative_assistant");
  });

  it("every ceo_view role resolves to its correct CEO View display name", () => {
    const roles = knownRolesForDisplayGroup("ceo_view");
    const namesByRole = Object.fromEntries(roles.map((r) => [r, roleDisplayName(r, "ceo_view")]));
    expect(namesByRole).toEqual({
      portfolio_manager: "Portfolio Manager",
      portfolio_assistant: "Assistant Property Manager",
      bookkeeper: "Bookkeeping Coordinator",
    });
  });
});
