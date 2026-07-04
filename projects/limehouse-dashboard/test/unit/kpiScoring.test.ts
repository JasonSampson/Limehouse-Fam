import { describe, it, expect } from "vitest";
import { scoreBand, scoreRole, type KpiInput } from "../../src/kpi/scoring.js";

// Reproduces the 5 known-good role totals captured from the live vendor
// dashboard (see project brief), using the TWO-DIVISOR formula confirmed
// directly against the live site's own legend text and displayed score
// fraction for Bookkeeper (the only one of the 5 with a no-data KPI):
//
//   Dollar payout:  per_kpi_max = role_max_bonus / ORIGINAL kpi count
//                   (Bookkeeper's site legend: "4 KPIs x $125 max each" —
//                   500/4, NOT 500/3 even though only 3 had data)
//   Percent score:  scored points / (3 * SCORED kpi count) * 100
//                   (Bookkeeper's site legend: "Score: 4/9 (44%)" — 3
//                   scored KPIs x 3 points max = 9, Reconciliation Accuracy
//                   excluded entirely, not just zero-scored)
//
// For the other 4 roles (no no-data KPIs), original count === scored
// count, so this collapses to the same simple single-divisor formula.
describe("scoreBand direction-aware banding", () => {
  it("bands a higher-is-better KPI correctly", () => {
    // target = 100
    expect(scoreBand(100, 100, true)).toBe("best");
    expect(scoreBand(105, 100, true)).toBe("best");
    expect(scoreBand(90, 100, true)).toBe("better"); // exactly target*0.9
    expect(scoreBand(95, 100, true)).toBe("better");
    expect(scoreBand(80, 100, true)).toBe("good"); // exactly target*0.8
    expect(scoreBand(85, 100, true)).toBe("good");
    expect(scoreBand(79, 100, true)).toBe("red");
    expect(scoreBand(0, 100, true)).toBe("red");
  });

  it("bands a lower-is-better KPI correctly (direction flipped)", () => {
    // target = 10 (e.g. days on market)
    expect(scoreBand(10, 10, false)).toBe("best");
    expect(scoreBand(5, 10, false)).toBe("best"); // beating target is still best
    expect(scoreBand(11, 10, false)).toBe("better"); // exactly target*1.1
    expect(scoreBand(10.5, 10, false)).toBe("better");
    expect(scoreBand(12, 10, false)).toBe("good"); // exactly target*1.2
    expect(scoreBand(11.5, 10, false)).toBe("good");
    expect(scoreBand(12.01, 10, false)).toBe("red");
  });

  // TARS regression coverage, round 1 (2026-07-03): target values of 100
  // and 10 above are "clean" in floating point (100*0.8 === 80 exactly,
  // 10*1.1 === 11 exactly), which is exactly why the original bug slipped
  // past those tests. target * 0.8/0.9/1.1/1.2 is NOT always exact in IEEE
  // 754 floating point for realistic KPI target values — e.g. 3 * 0.8 ===
  // 2.4000000000000004, not 2.4. Before the fix, an actual value sitting
  // exactly on a boundary could fail its >= / <= comparison and get
  // silently downgraded one full band (Good, real bonus dollars, becoming
  // Red, $0). These cases use target values (3, 1.5, 6, 7) chosen
  // specifically because they DO produce float noise, confirmed via
  // `3 * 0.8 === 2.4000000000000004` in plain Node before the first fix.
  it("classifies exact-boundary values correctly even when target * multiplier is not exact in floating point", () => {
    // target=3, higher-is-better: 3*0.8 = 2.4000000000000004 in raw JS float math.
    expect(scoreBand(2.4, 3, true)).toBe("good");
    // target=1.5, lower-is-better: 1.5*1.2 = 1.7999999999999998 in raw JS float math.
    expect(scoreBand(1.8, 1.5, false)).toBe("good");
    // target=6, higher-is-better: 6*0.9 = 5.4 exactly, but paired here with
    // a target that also has float noise on the 0.8 boundary (6*0.8 =
    // 4.800000000000001) to cover both boundaries on one target.
    expect(scoreBand(5.4, 6, true)).toBe("better");
    expect(scoreBand(4.8, 6, true)).toBe("good");
    // target=7, lower-is-better: 7*1.1 = 7.700000000000001 in raw JS float math.
    expect(scoreBand(7.7, 7, false)).toBe("better");
    // target=7, lower-is-better: 7*1.2 = 8.4 with float noise upstream of it.
    expect(scoreBand(8.4, 7, false)).toBe("good");
  });

  // TARS regression coverage, round 2 (2026-07-03): the FIRST fix for the
  // bug above (rounding both sides of the comparison to a fixed 4 decimal
  // places) over-corrected — it could round a value that is GENUINELY, by a
  // real and meaningful margin, short of or past a cutoff across the line
  // the wrong way. Confirmed independently before the second fix: the
  // deltas below (~1e-6) are about 1000x larger than the 1e-9 epsilon the
  // second fix uses, so they are real data differences, not
  // multiplication noise, and must NOT be treated as "at the boundary."
  it("does NOT misclassify a value that is genuinely (not just float-noise) short of or past a boundary", () => {
    // target=100, higher-is-better: 89.999999 is truly 0.000001 short of
    // the 90 "better" cutoff — must stay "good," not get rounded up to "better."
    expect(scoreBand(89.999999, 100, true)).toBe("good");
    // target=95, higher-is-better: 85.499999 is truly short of the 85.5
    // "better" cutoff (95*0.9=85.5) — must stay "good."
    expect(scoreBand(85.499999, 95, true)).toBe("good");
    // target=10, lower-is-better: 12.000001 is truly past the 12 "good"
    // cutoff (10*1.2=12) — must be "red," not rounded down into "good."
    expect(scoreBand(12.000001, 10, false)).toBe("red");
  });
});

describe("scoreRole reproduces known-good totals from the live vendor site", () => {
  it("Portfolio Manager: 1 Best + 3 Red across 4 KPIs (all scored) = $250 / $1000 (25%)", () => {
    const kpis: KpiInput[] = [
      { kpiName: "Occupancy Rate", hasData: true, actualValue: 96, targetValue: 95, higherIsBetter: true }, // best
      { kpiName: "Renewal Rate", hasData: true, actualValue: 40, targetValue: 70, higherIsBetter: true }, // red
      { kpiName: "Response Time", hasData: true, actualValue: 20, targetValue: 5, higherIsBetter: false }, // red
      { kpiName: "Inspection Compliance", hasData: true, actualValue: 30, targetValue: 90, higherIsBetter: true }, // red
    ];
    const result = scoreRole("portfolio_manager", 1000, kpis);
    expect(result.originalKpiCount).toBe(4);
    expect(result.scoredKpiCount).toBe(4);
    expect(result.totalPayoutUsd).toBe(250);
    expect(result.percentOfMax).toBe(25);
  });

  it("Portfolio Assistant: Better + Red across 2 KPIs (all scored) = $250 / $750 (33%)", () => {
    const kpis: KpiInput[] = [
      { kpiName: "Task Completion", hasData: true, actualValue: 91, targetValue: 100, higherIsBetter: true }, // better (>=90%)
      { kpiName: "Data Accuracy", hasData: true, actualValue: 40, targetValue: 90, higherIsBetter: true }, // red
    ];
    const result = scoreRole("portfolio_assistant", 750, kpis);
    expect(result.originalKpiCount).toBe(2);
    expect(result.scoredKpiCount).toBe(2);
    expect(result.totalPayoutUsd).toBe(250);
    expect(result.percentOfMax).toBe(33.3);
  });

  it("Leasing Specialist: Better + Red + Red across 3 KPIs (all scored) = $111 / $500 (22%)", () => {
    const kpis: KpiInput[] = [
      { kpiName: "Days on Market", hasData: true, actualValue: 11, targetValue: 10, higherIsBetter: false }, // better (<=11)
      { kpiName: "Showing-to-Lease Ratio", hasData: true, actualValue: 5, targetValue: 20, higherIsBetter: true }, // red
      { kpiName: "Application Turnaround", hasData: true, actualValue: 10, targetValue: 2, higherIsBetter: false }, // red
    ];
    const result = scoreRole("leasing_specialist", 500, kpis);
    expect(result.originalKpiCount).toBe(3);
    expect(result.scoredKpiCount).toBe(3);
    expect(result.totalPayoutUsd).toBe(111.11);
    expect(result.percentOfMax).toBe(22.2);
  });

  it("Administrative Assistant: Best + Better + Red across 3 KPIs (all scored) = $278 / $500 (56%)", () => {
    const kpis: KpiInput[] = [
      { kpiName: "Filing Accuracy", hasData: true, actualValue: 100, targetValue: 95, higherIsBetter: true }, // best
      { kpiName: "Response Time", hasData: true, actualValue: 5.4, targetValue: 5, higherIsBetter: false }, // better (<=5.5)
      { kpiName: "Call Answer Rate", hasData: true, actualValue: 40, targetValue: 90, higherIsBetter: true }, // red
    ];
    const result = scoreRole("administrative_assistant", 500, kpis);
    expect(result.originalKpiCount).toBe(3);
    expect(result.scoredKpiCount).toBe(3);
    expect(result.totalPayoutUsd).toBe(277.78);
    expect(result.percentOfMax).toBe(55.6);
  });

  it("Bookkeeper: Reconciliation Accuracy (no data) excluded from the PERCENT denominator, but per_kpi_max still divides by the ORIGINAL 4 KPIs = $167 / $500 (44%)", () => {
    const kpis: KpiInput[] = [
      { kpiName: "Reconciliation Accuracy", hasData: false, actualValue: null, targetValue: 100, higherIsBetter: true },
      { kpiName: "Rent Processing Accuracy", hasData: true, actualValue: 100, targetValue: 95, higherIsBetter: true }, // best (3pts)
      { kpiName: "Vendor Compliance", hasData: true, actualValue: 40, targetValue: 90, higherIsBetter: true }, // red (0pts)
      { kpiName: "1099 Compliance", hasData: true, actualValue: 75, targetValue: 90, higherIsBetter: true }, // good (1pt): 75 is in [72,81)
    ];
    const result = scoreRole("bookkeeper", 500, kpis);

    // Dollar side: per_kpi_max = $500 / 4 (ORIGINAL count, Reconciliation
    // Accuracy included in this denominator despite having no data) = $125.
    expect(result.originalKpiCount).toBe(4);
    expect(result.kpis.find((k) => k.kpiName === "Reconciliation Accuracy")?.perKpiMax).toBe(125);

    // Percent side: only 3 KPIs have data (Reconciliation Accuracy fully
    // excluded from this denominator, not just zero-scored).
    expect(result.scoredKpiCount).toBe(3);

    // Exact reproduction of the live site's own displayed numbers.
    expect(result.totalPayoutUsd).toBe(166.67);
    expect(result.percentOfMax).toBe(44.4);
  });
});

describe("scoreRole handles the Marketing Specialist empty-KPI state cleanly", () => {
  it("returns a clean zero-KPI result instead of throwing when no KPIs are configured", () => {
    const result = scoreRole("marketing_specialist", 0, []);
    expect(result.originalKpiCount).toBe(0);
    expect(result.scoredKpiCount).toBe(0);
    expect(result.totalPayoutUsd).toBe(0);
    expect(result.percentOfMax).toBe(0);
    expect(result.kpis).toEqual([]);
  });
});

describe("scoreRole excludes no-data KPIs from the percent calculation without treating them as zero-scored", () => {
  it("a KPI with hasData=false contributes $0 (not null) to the dollar total, and null band/points", () => {
    const kpis: KpiInput[] = [
      { kpiName: "Configured But No Data Yet", hasData: false, actualValue: null, targetValue: 50, higherIsBetter: true },
    ];
    const result = scoreRole("some_role", 500, kpis);
    expect(result.originalKpiCount).toBe(1);
    expect(result.scoredKpiCount).toBe(0);
    expect(result.kpis[0].band).toBeNull();
    expect(result.kpis[0].scorePoints).toBeNull();
    expect(result.kpis[0].payoutUsd).toBe(0); // real $0, not null — it simply has no data to score
    expect(result.totalPayoutUsd).toBe(0);
    // percentOfMax is 0 here NOT because the KPI "scored zero" but because
    // scoredKpiCount is 0 (nothing to average) — the empty-denominator
    // guard, same as the Marketing Specialist empty-state case.
    expect(result.percentOfMax).toBe(0);
  });
});
