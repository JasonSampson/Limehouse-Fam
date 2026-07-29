// CONSOLIDATED 2026-07-30, per Judge's code-quality review: this exact
// pair of functions was copy-pasted, private and unexported, into 8
// different files (src/kpi/bookkeeperMetrics.ts, src/kpi/churn.ts,
// src/kpi/occupancy.ts, src/kpi/rentCollection.ts, src/kpi/scoring.ts,
// src/buildium/delinquency.ts, src/kpi/financialSummary.ts,
// src/leadsimple/client.ts). These are the rounding rules behind every
// percentage and dollar figure the dashboard shows — a future fix to one
// copy silently not applying to the others would let tiles quietly
// disagree with each other, with no test to catch the drift.
export function roundPercent(n: number): number {
  return Math.round(n * 10) / 10;
}

export function roundCurrency(n: number): number {
  return Math.round(n * 100) / 100;
}
