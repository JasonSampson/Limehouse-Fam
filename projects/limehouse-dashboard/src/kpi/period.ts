// Resolves the dashboard's period selector ("this_month" | "last_month" |
// "this_quarter" | "last_quarter" | "this_year" | "last_year") into a
// concrete date range. This is ONLY used by tiles classified "flow" (Oracle's
// spec — changes with the period selector). Tiles classified "structural"
// (e.g. current occupancy, total units) must NEVER call this function or
// take a period param at all — they are always as-of-today regardless of
// what the user has selected, which is why summarizeOccupancy/
// summarizeLeaseMix in src/kpi/occupancy.ts intentionally have no period
// argument.
export type PeriodKey = "this_month" | "last_month" | "this_quarter" | "last_quarter" | "this_year" | "last_year";

export interface DateRange {
  from: string; // "YYYY-MM-DD"
  to: string; // "YYYY-MM-DD", inclusive
}

export function resolvePeriod(period: PeriodKey, now: Date = new Date()): DateRange {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed

  switch (period) {
    case "this_month":
      return monthRange(year, month);
    case "last_month":
      return monthRange(year, month - 1);
    case "this_quarter":
      return quarterRange(year, quarterOf(month));
    case "last_quarter": {
      const q = quarterOf(month);
      return q === 0 ? quarterRange(year - 1, 3) : quarterRange(year, (q - 1) as 0 | 1 | 2 | 3);
    }
    case "this_year":
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    case "last_year":
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    default: {
      const _exhaustive: never = period;
      throw new Error(`Unknown period: ${_exhaustive}`);
    }
  }
}

function quarterOf(monthIndex: number): 0 | 1 | 2 | 3 {
  return Math.floor(monthIndex / 3) as 0 | 1 | 2 | 3;
}

function monthRange(year: number, monthIndex: number): DateRange {
  // Normalize monthIndex outside 0-11 (e.g. -1 for "last month" in
  // January) via Date's own rollover behavior.
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const last = new Date(Date.UTC(year, monthIndex + 1, 0)); // day 0 of next month = last day of this month
  return { from: toDateString(first), to: toDateString(last) };
}

function quarterRange(year: number, quarter: 0 | 1 | 2 | 3): DateRange {
  const startMonth = quarter * 3;
  const first = new Date(Date.UTC(year, startMonth, 1));
  const last = new Date(Date.UTC(year, startMonth + 3, 0));
  return { from: toDateString(first), to: toDateString(last) };
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Also converts a period key into the 'YYYY-Qn' label format used by
// dashboard_kpi_snapshots.period (Neo's migration 0003 comment: "e.g.
// '2026-Q2'").
export function periodToSnapshotLabel(period: PeriodKey, now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const q = quarterOf(month);

  if (period === "this_quarter") return `${year}-Q${q + 1}`;
  if (period === "last_quarter") {
    return q === 0 ? `${year - 1}-Q4` : `${year}-Q${q}`;
  }
  // this_month/last_month/this_year/last_year don't map to a quarter label
  // cleanly — KPI snapshots are inherently quarterly (per Neo's schema), so
  // callers requesting Team Performance data for a non-quarter period
  // should resolve to the CONTAINING quarter's label instead.
  return `${year}-Q${q + 1}`;
}
