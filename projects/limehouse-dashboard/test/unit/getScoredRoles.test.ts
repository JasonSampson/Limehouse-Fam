import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression coverage for the TARS-found bug (2026-07-03): getScoredRoles()
// used its ceo_view allowlist only to PRE-SEED empty buckets, but the loop
// over getKpiDefinitions() results would silently create a new bucket for
// ANY role slug encountered — allowlisted or not — because
// getKpiDefinitions(displayGroup) only filters by the display_group COLUMN
// in SQL, never by role. TARS reproduced this live by inserting real
// dashboard_kpi_definitions rows with display_group='ceo_view' for
// leasing_specialist and administrative_assistant (roles that must never
// appear on CEO View) and got back 5 roles instead of 3, with two fully
// real-looking phantom cards.
//
// This test calls getScoredRoles() ITSELF (not just the isolated
// roleDisplayName/knownRolesForDisplayGroup helpers, which is exactly the
// gap TARS identified — those pass today but don't exercise the actual
// bug) against a mocked DB layer that returns exactly this kind of
// realistic-but-out-of-allowlist data, and asserts the returned array is
// hard-filtered to the correct 3 roles regardless of what the query
// returns.
const mockQuery = vi.fn();
vi.mock("../../src/db/pool.js", () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted above imports
// by vitest, so this ordering is safe) so getScoredRoles() picks up the
// mocked getPool().
const { getScoredRoles } = await import("../../src/db/kpiRepository.js");

// Row shapes matching exactly what the real SQL queries in
// getKpiDefinitions/getKpiSnapshots select (snake_case columns, as `pg`
// would return them) — see src/db/kpiRepository.ts for the real queries
// this fixture data must stay shaped like.
function definitionRow(overrides: Partial<Record<string, unknown>>) {
  return {
    id: 1,
    role: "portfolio_manager",
    kpi_name: "occupancy_rate",
    display_group: "ceo_view",
    display_label: "Portfolio Manager",
    target_value: "95",
    target_operator: ">=",
    unit: "percent",
    higher_is_better: true,
    source_system: "buildium",
    max_bonus_usd: "1000",
    sort_order: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
});

describe("getScoredRoles hard-filters output to the display group's allowlist", () => {
  it("excludes a stray out-of-allowlist role (leasing_specialist) from ceo_view results, even with real, well-formed data for it in the DB", async () => {
    // First call inside getScoredRoles is getKpiDefinitions(); second is
    // getKpiSnapshots() (see the source — that ordering is load-bearing for
    // this mock, matching how the real functions are called).
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          definitionRow({ id: 1, role: "portfolio_manager" }),
          definitionRow({ id: 2, role: "portfolio_assistant", kpi_name: "task_completion" }),
          definitionRow({ id: 3, role: "bookkeeper", kpi_name: "processing_time" }),
          // The exact scenario TARS reproduced: a well-formed row for a
          // role that should NEVER appear on ceo_view.
          definitionRow({ id: 4, role: "leasing_specialist", kpi_name: "days_on_market" }),
          definitionRow({ id: 5, role: "administrative_assistant", kpi_name: "filing_accuracy" }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // no snapshots needed for this assertion

    const roles = await getScoredRoles("2026-Q3", "ceo_view");

    expect(roles).toHaveLength(3);
    const roleSlugs = roles.map((r) => r.role);
    expect(roleSlugs).toEqual(expect.arrayContaining(["portfolio_manager", "portfolio_assistant", "bookkeeper"]));
    expect(roleSlugs).not.toContain("leasing_specialist");
    expect(roleSlugs).not.toContain("administrative_assistant");
  });

  it("still returns exactly 3 ceo_view roles when the DB has ONLY the allowlisted ones (no regression on the normal case)", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          definitionRow({ id: 1, role: "portfolio_manager" }),
          definitionRow({ id: 2, role: "portfolio_assistant" }),
          definitionRow({ id: 3, role: "bookkeeper" }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const roles = await getScoredRoles("2026-Q3", "ceo_view");
    expect(roles).toHaveLength(3);
  });

  it("does NOT filter team_performance results the same way — all 6 roles remain, including ones with zero DB rows", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [definitionRow({ id: 1, role: "portfolio_manager", display_group: "team_performance" })],
      })
      .mockResolvedValueOnce({ rows: [] });

    const roles = await getScoredRoles("2026-Q3", "team_performance");
    expect(roles).toHaveLength(6); // team_performance genuinely has all 6, incl. Marketing Specialist's empty state
    expect(roles.map((r) => r.role)).toEqual(
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

  it("a stray ceo_view role's KPI data never leaks into an allowlisted role's score (no cross-contamination)", async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          definitionRow({ id: 1, role: "portfolio_manager", max_bonus_usd: "1000" }),
          // Stray role with its own (different) max bonus — if this ever
          // leaked into portfolio_manager's bucket, its maxBonusUsd would
          // be wrong (Math.max(1000, 9999) = 9999) as a symptom.
          definitionRow({ id: 2, role: "leasing_specialist", max_bonus_usd: "9999" }),
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const roles = await getScoredRoles("2026-Q3", "ceo_view");
    const pm = roles.find((r) => r.role === "portfolio_manager");
    expect(pm?.maxBonusUsd).toBe(1000);
  });
});
