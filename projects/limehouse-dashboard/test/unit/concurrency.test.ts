import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../../src/lib/concurrency.js";

describe("mapWithConcurrency", () => {
  it("returns results in the same order as the input, regardless of completion order", async () => {
    const items = [30, 10, 20];
    const results = await mapWithConcurrency(items, 3, (ms) => new Promise((resolve) => setTimeout(() => resolve(ms), ms)));
    expect(results).toEqual([30, 10, 20]);
  });

  it("never runs more than `limit` callbacks at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 4, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("processes every item exactly once", async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const seen: number[] = [];
    await mapWithConcurrency(items, 7, async (i) => {
      seen.push(i);
      return i * 2;
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it("handles an empty input array", async () => {
    const results = await mapWithConcurrency([], 5, async (i: number) => i);
    expect(results).toEqual([]);
  });

  it("handles a limit larger than the item count", async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (i) => i * 10);
    expect(results).toEqual([10, 20]);
  });
});
