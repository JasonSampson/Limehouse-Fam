import { describe, it, expect, vi, afterEach } from "vitest";
import { RateLimiter } from "../../src/lib/globalRequestLimiter.js";

// RateLimiter skips its own throttling when NODE_ENV is "test" (see its
// own comment) — Vitest sets that automatically, so these tests explicitly
// stub NODE_ENV to something else to actually exercise the real budget
// logic, restoring it afterward so no other test file is affected.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("RateLimiter", () => {
  it("runs immediately with no artificial delay when NODE_ENV is test", async () => {
    const limiter = new RateLimiter(1, 1 / 60_000); // would take a real minute to refill if NODE_ENV weren't "test"
    const start = Date.now();
    await limiter.run(() => Promise.resolve("ok"));
    await limiter.run(() => Promise.resolve("ok"));
    await limiter.run(() => Promise.resolve("ok"));
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("lets an uncontested burst up to capacity run at full speed, concurrently", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    const limiter = new RateLimiter(5, 1 / 60_000); // slow refill — this test only exercises the burst capacity, not refill
    const order: string[] = [];

    // 5 calls, each holding its "slot" open until released — if they ran
    // one-at-a-time (the old strict-serialization behavior), "call N start"
    // would never appear before "call 1 end". Under the token-bucket model,
    // all 5 should start immediately since capacity covers all of them.
    const releases: Array<() => void> = [];
    const calls = Array.from({ length: 5 }, (_, i) =>
      limiter.run(
        () =>
          new Promise<void>((resolve) => {
            order.push(`call ${i} start`);
            releases.push(resolve);
          })
      )
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["call 0 start", "call 1 start", "call 2 start", "call 3 start", "call 4 start"]);

    releases.forEach((release) => release());
    await Promise.all(calls);
  });

  it("throttles once capacity is exhausted, waiting for refill before the next call proceeds", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    const limiter = new RateLimiter(2, 1 / 1000); // 2 tokens, refills 1 per 1000ms
    const order: string[] = [];

    // Drain the bucket with 2 quick calls.
    await limiter.run(async () => {
      order.push("a");
    });
    await limiter.run(async () => {
      order.push("b");
    });

    // A 3rd call must wait for a token to refill — not proceed instantly.
    const third = limiter.run(async () => {
      order.push("c");
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual(["a", "b"]); // still waiting at the halfway point

    await vi.advanceTimersByTimeAsync(600);
    await third;
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("a rejected call doesn't jam the queue for the next caller", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers();
    const limiter = new RateLimiter(5, 1 / 1000);

    const first = limiter.run(() => Promise.reject(new Error("boom")));
    await expect(first).rejects.toThrow("boom");

    const second = limiter.run(() => Promise.resolve("still works"));
    await vi.runAllTimersAsync();
    await expect(second).resolves.toBe("still works");
  });
});
