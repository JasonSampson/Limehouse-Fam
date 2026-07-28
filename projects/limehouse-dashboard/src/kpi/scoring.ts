// KPI scoring engine for the Team Performance tab. Implements the formula
// confirmed against the live vendor dashboard's own displayed numbers and
// legend text — see test/unit/kpiScoring.test.ts for the 5 known-good role
// totals this must reproduce exactly.
//
// TWO SEPARATE DIVISORS — this is the key correction from an earlier draft
// of this formula that only used one:
//
//   1. DOLLAR PAYOUT uses the role's ORIGINAL configured KPI count (how
//      many KPIs the role has defined, period — NOT reduced when a KPI has
//      no data yet):
//        per_kpi_max = role_max_bonus / original_kpi_count
//        each KPI's payout = per_kpi_max * (score_points / 3)
//        a "no data" KPI contributes $0 and is otherwise skipped — its
//        SHARE of the max isn't redistributed to the other KPIs.
//      Confirmed directly from the live site's own legend: Bookkeeper shows
//      "4 KPIs x $125 max each" — $125 = $500 / 4 (original count), even
//      though only 3 of the 4 had data. Reconciliation Accuracy (no data)
//      contributes $0 to the sum, same arithmetic result as a Red score,
//      but semantically distinct (see has_data on each KpiScoreResult).
//
//   2. PERCENT SCORE uses only the SCORED count (KPIs that HAVE data),
//      excluding no-data KPIs from both the numerator and denominator:
//        percent = (sum of raw score points for scored KPIs)
//                  / (3 * scored_kpi_count) * 100
//      Confirmed against the live site's own displayed "Score: 4/9 (44%)"
//      for Bookkeeper: 3 scored KPIs (Reconciliation Accuracy excluded
//      entirely) x 3 points max each = 9; actual points scored = 3+0+1 = 4;
//      4/9 = 44.4%.
//
// When every KPI has data (original_count === scored_count, true for
// Portfolio Manager, Portfolio Assistant, Leasing Specialist, and
// Administrative Assistant — none of them have a no-data KPI), this
// collapses to the same single-divisor formula already verified for those
// 4 roles: per_kpi_max * scored_count === role_max_bonus, so percent-of-
// dollar-max and the points-based percent agree. Bookkeeper's Reconciliation
// Accuracy is the only KPI in the known-good set with no data, which is why
// it's the only role where the two formulas diverge.
//
// Score bands (direction-aware) map to raw points out of 3, not just a
// dollar multiplier, because the percent calculation needs the point value
// independent of dollars:
//   Best   (meets/exceeds target)      = 3/3 points = 100% of per_kpi_max
//   Better (within 10% of target)      = 2/3 points = 66.7% of per_kpi_max
//   Good   (within 20% of target)      = 1/3 points = 33.3% of per_kpi_max
//   Red    (missed by more than 20%)   = 0/3 points = 0% of per_kpi_max
//
// Direction-aware bands:
//   higher-is-better (occupancy, renewal rate, completion rate, ...):
//     Best:   actual >= target
//     Better: actual >= target * 0.9
//     Good:   actual >= target * 0.8
//     Red:    below that
//   lower-is-better (days on market, response time, processing time, ...):
//     Best:   actual <= target
//     Better: actual <= target * 1.1
//     Good:   actual <= target * 1.2
//     Red:    above that

export type ScoreBand = "best" | "better" | "good" | "red";

// Raw points out of 3 — the shared unit both the dollar and percent
// calculations derive from. Exported so a single-KPI snapshot writer
// (db/kpiRepository.ts's upsertKpiSnapshot) can store the same point value
// scoreRole() derives at read time, without duplicating this mapping.
export const BAND_POINTS: Record<ScoreBand, number> = {
  best: 3,
  better: 2,
  good: 1,
  red: 0,
};

export interface KpiInput {
  kpiName: string;
  hasData: boolean;
  actualValue: number | null;
  targetValue: number;
  higherIsBetter: boolean;
  // targetOperator/unit/sourceSystem — ADDED 2026-07-19, per Jason directly,
  // to match the vendor's real KPI table layout (Target/Actual columns and
  // BD/RE/LS source badges), which this scoring engine previously had no
  // way to surface at all. Pass-through fields only — scoreRole() doesn't
  // use these for any math, it just carries them onto each KpiScoreResult
  // so the API/frontend don't need a second lookup back to the KPI
  // definition just to render what target/actual/source a score came from.
  targetOperator: ">=" | "<=";
  unit: string;
  // WIDENED 2026-07-27, per Jason directly, from a single value to a list —
  // see the comment on KpiDefinitionRow.sourceSystem in
  // src/db/kpiRepository.ts for why (Leasing Response Time genuinely draws
  // from both RentEngine and LeadSimple). Pass-through only, same as
  // before — scoreRole() doesn't use this for any math.
  sourceSystem: string[];
}

export interface KpiScoreResult {
  kpiName: string;
  hasData: boolean;
  band: ScoreBand | null; // null when hasData is false — excluded from the percent calculation
  scorePoints: number | null; // 0-3, null when hasData is false
  perKpiMax: number | null; // role_max_bonus / ORIGINAL kpi count, same for every KPI on this role
  payoutUsd: number | null; // 0 (not null) when hasData is false — contributes nothing but is a real, known $0
  actualValue: number | null;
  targetValue: number;
  targetOperator: ">=" | "<=";
  unit: string;
  sourceSystem: string[];
}

export interface RoleScoreResult {
  role: string;
  maxBonusUsd: number;
  originalKpiCount: number; // denominator for per_kpi_max (dollar side)
  scoredKpiCount: number; // denominator for percent (points side) — KPIs WITH data only
  totalPayoutUsd: number;
  percentOfMax: number; // points-based percent: scored points / (3 * scoredKpiCount), 0 when scoredKpiCount is 0
  // totalScorePoints/maxScorePoints — ADDED 2026-07-19, per Jason directly,
  // to reproduce the vendor's own "Score: 2/6 (33%)" text exactly (the
  // raw fraction behind percentOfMax, not just the rounded percent).
  totalScorePoints: number;
  maxScorePoints: number; // 3 * scoredKpiCount
  kpis: KpiScoreResult[];
}

// Determines which of the 4 bands a single KPI falls into, direction-aware.
//
// BOUNDARY FIX, take 2 (TARS found a regression in the first attempt,
// confirmed independently before patching again): rounding both sides of
// the comparison to a fixed 4 decimal places fixed the original float-noise
// bug (target=3, actual=2.4 now correctly reads as "good"), but it was too
// blunt — it could also pull a value that is GENUINELY short of a cutoff by
// a real, meaningful amount across the line the wrong way. Confirmed:
// target=100, actual=89.999999 (truly 0.000001 short of the 90 cutoff)
// rounded to 90.0000 and got misclassified "better" instead of "good."
//
// Correct fix: don't round the values. Use an epsilon tolerance that only
// treats two numbers as equal when they differ by an amount consistent with
// floating-point multiplication noise (~1e-15 scale for numbers in the
// range KPI targets live in), never by anything a real KPI computation
// would produce (5-6 decimal places is already far outside float noise).
// EPSILON is deliberately many orders of magnitude tighter than
// BOUNDARY_PRECISION was — it cancels representation noise ONLY, it does
// not swallow real differences in the data the way rounding did.
const EPSILON = 1e-9;

function isAtOrPast(actual: number, boundary: number, direction: "gte" | "lte"): boolean {
  if (Math.abs(actual - boundary) < EPSILON) return true; // at the boundary, float noise aside
  return direction === "gte" ? actual > boundary : actual < boundary;
}

export function scoreBand(actual: number, target: number, higherIsBetter: boolean): ScoreBand {
  if (higherIsBetter) {
    if (isAtOrPast(actual, target, "gte")) return "best";
    if (isAtOrPast(actual, target * 0.9, "gte")) return "better";
    if (isAtOrPast(actual, target * 0.8, "gte")) return "good";
    return "red";
  } else {
    if (isAtOrPast(actual, target, "lte")) return "best";
    if (isAtOrPast(actual, target * 1.1, "lte")) return "better";
    if (isAtOrPast(actual, target * 1.2, "lte")) return "good";
    return "red";
  }
}

// Scores every KPI for one role. `maxBonusUsd` is the role's total possible
// bonus (e.g. $500 for Bookkeeper). `kpiInputs` must include EVERY KPI
// configured for the role, including ones with hasData=false — the length
// of this array IS the "original KPI count" the dollar side divides by.
export function scoreRole(role: string, maxBonusUsd: number, kpiInputs: KpiInput[]): RoleScoreResult {
  const originalKpiCount = kpiInputs.length;
  const perKpiMax = originalKpiCount > 0 ? maxBonusUsd / originalKpiCount : 0;

  const kpis: KpiScoreResult[] = kpiInputs.map((k) => {
    if (!k.hasData || k.actualValue === null) {
      // No data: excluded from scoring/percent entirely, but still
      // contributes a real (not null) $0 to the dollar total — its share
      // of per_kpi_max simply goes unclaimed, not redistributed.
      return {
        kpiName: k.kpiName,
        hasData: false,
        band: null,
        scorePoints: null,
        perKpiMax: roundCurrency(perKpiMax),
        payoutUsd: 0,
        actualValue: null,
        targetValue: k.targetValue,
        targetOperator: k.targetOperator,
        unit: k.unit,
        sourceSystem: k.sourceSystem,
      };
    }
    const band = scoreBand(k.actualValue, k.targetValue, k.higherIsBetter);
    const scorePoints = BAND_POINTS[band];
    const payoutUsd = roundCurrency(perKpiMax * (scorePoints / 3));
    return {
      kpiName: k.kpiName,
      hasData: true,
      band,
      scorePoints,
      perKpiMax: roundCurrency(perKpiMax),
      payoutUsd,
      actualValue: k.actualValue,
      targetValue: k.targetValue,
      targetOperator: k.targetOperator,
      unit: k.unit,
      sourceSystem: k.sourceSystem,
    };
  });

  const totalPayoutUsd = roundCurrency(kpis.reduce((sum, k) => sum + (k.payoutUsd ?? 0), 0));

  const scoredKpis = kpis.filter((k) => k.hasData);
  const scoredKpiCount = scoredKpis.length;
  const totalScorePoints = scoredKpis.reduce((sum, k) => sum + (k.scorePoints ?? 0), 0);
  const percentOfMax = scoredKpiCount > 0 ? roundPercent((totalScorePoints / (3 * scoredKpiCount)) * 100) : 0;

  return {
    role,
    maxBonusUsd,
    originalKpiCount,
    scoredKpiCount,
    totalPayoutUsd,
    percentOfMax,
    totalScorePoints,
    maxScorePoints: 3 * scoredKpiCount,
    kpis,
  };
}

// Cents-precision rounding for dollar payouts — avoids floating point noise
// like 166.66666666666669 showing up in API responses.
function roundCurrency(n: number): number {
  return Math.round(n * 100) / 100;
}

// One-decimal rounding for percentages (e.g. 44.4%, not 44.44444%).
function roundPercent(n: number): number {
  return Math.round(n * 10) / 10;
}
