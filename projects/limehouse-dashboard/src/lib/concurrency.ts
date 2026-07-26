// ADDED 2026-07-26, per Jason directly ("sure does take a long time to
// load"): Rent Processing Accuracy's drill-down originally fetched every
// active lease's transactions one at a time (~215 leases, each its own
// Buildium round trip) — slow. Firing all 215 at once instead (plain
// Promise.all) is worse: CONFIRMED LIVE, Buildium rate-limits that hard
// enough that even its own 4-attempt retry-with-backoff (see
// buildium/client.ts) can't recover, since every request in the burst
// retries on roughly the same schedule and re-collides. A modest,
// fixed-size concurrency cap gets most of the parallel speedup without
// tripping the limit.
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
