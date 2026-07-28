// ADDED 2026-07-28, per Jason directly, closing the gap documented in
// memory as "the dashboard needs a shared, app-wide gatekeeper for external
// API calls (Buildium AND LeadSimple) — background sync jobs and drilldown
// routes collide and cause real load failures."
//
// Retry-with-backoff (buildiumGet, leadSimpleGet, rentEngineGet all have
// this today) reacts AFTER a 429 already happened. It doesn't stop the
// COLLISION that causes it: several independent things (a scheduled sync
// job, a live drilldown a user just clicked, another sync job) each call
// these clients on their own schedule, with zero awareness of each other,
// so their combined request volume can burst past the real limit even
// though any ONE of them alone would have been fine.
//
// REVISED 2026-07-28, same day, after the first version (a strict
// fixed-interval serializer — every request through a limiter waited for
// the previous one to fully finish, no exceptions) was CONFIRMED LIVE to
// be the wrong shape: loading the dashboard cold, with nothing else
// running, took 40+ seconds because a single uncontested RentEngine
// pagination loop (leasing-funnel, ~12 pages for one month of prospects)
// got throttled as hard as if it were fighting another job for the same
// budget. That was never the real problem — a single job's own sequential
// pagination was already safe on its own (RentEngine's callActivitySync
// job proved this for months). The real problem is two independent things
// drawing from the SAME budget AT THE SAME TIME.
//
// A token bucket models that correctly: `capacity` tokens are available
// up front (a legitimate single-job burst spends them instantly, running
// at full speed, exactly like before this file existed), and they refill
// at `refillPerMs` — only once the bucket is actually drained (which only
// happens when something is drawing on it fast enough, i.e. a real
// collision) does a caller start waiting. One uncontested caller never
// notices the limiter is there; two colliding callers correctly share and
// throttle against the same budget instead of each independently blowing
// past the real API limit.
//
// CONFIRMED LIVE 2026-07-28, informing the three budgets below:
//   - Buildium: 100 sequential real requests at ~245ms apart (naturally
//     paced by each round-trip's own latency, no explicit throttling)
//     produced zero 429s — call it ~4/sec sustained is clearly fine. The
//     documented real failure (mapWithConcurrency's own comment in
//     src/lib/concurrency.ts) was a genuine PARALLEL burst (~215 requests
//     fired via Promise.all at once) — a generous burst capacity with a
//     roughly 10/sec refill comfortably covers normal use while still
//     capping a runaway parallel storm to a sane pace instead of an
//     instant 200-at-once spike.
//   - LeadSimple: real 429 response headers confirmed
//     x-ratelimit-metric-requests-limit: 100 over what its own error body
//     describes as "1 minute" — see leadSimpleGet's own comment in
//     src/leadsimple/client.ts for the full investigation, including why
//     the ALSO-confirmed records-based sub-limit still needs the existing
//     retry-with-backoff as a second layer (a request-count bucket alone
//     can't model "some responses carry more records than others").
//   - RentEngine: /calls and /messages already confirmed a real 30
//     req/min limit via X-Ratelimit-Limit (see rentEngineGet's own
//     comment in src/rentengine/client.ts). Applied as the shared budget
//     for every RentEngine endpoint, not just calls/messages, since
//     there's no evidence any other endpoint has a looser limit and this
//     is the only confirmed number available — this also replaces
//     callActivitySync.ts's own hand-rolled per-call-site spacing with
//     the same protection applied globally, so every OTHER RentEngine
//     call site gets it too, not just that one job.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimiter {
  private tokens: number;
  private lastRefillAt = Date.now();
  // Serializes the ACQUIRE step only (the token math + wait-if-empty), not
  // the caller's actual work — once a caller has a token in hand it runs
  // fn() independently, concurrently with anyone else who already has one.
  // That's what makes an uncontested burst run at full speed instead of
  // being forced through one-at-a-time like the first version of this file.
  private acquireQueue: Promise<void> = Promise.resolve();

  constructor(private readonly capacity: number, private readonly refillPerMs: number) {
    this.tokens = capacity;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillAt;
    if (elapsedMs > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.refillPerMs);
      this.lastRefillAt = now;
    }
  }

  private acquire(): Promise<void> {
    const turn = this.acquireQueue.then(async () => {
      // Vitest sets NODE_ENV=test automatically (confirmed live) — checked
      // raw here rather than through loadEnv() (which validates required
      // env vars a given test file may not have stubbed yet) so this never
      // throws on import. Without this, the shared singleton instances
      // below would carry real budget state across the whole test suite —
      // a real correctness feature in production, pure noise in a suite
      // that mocks fetch and has no actual rate limit to respect.
      if (process.env.NODE_ENV === "test") return;
      for (;;) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const waitMs = Math.max(1, (1 - this.tokens) / this.refillPerMs);
        await sleep(waitMs);
      }
    });
    // The queue chain itself must never reject.
    this.acquireQueue = turn.then(
      () => undefined,
      () => undefined
    );
    return turn;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    return fn();
  }
}

// One shared instance per external API — imported by that API's client
// file only, so every call site (route, background job, drilldown) that
// goes through the client automatically shares the same budget with every
// other call site, with no per-caller opt-in required.
export const buildiumLimiter = new RateLimiter(20, 10 / 1000);
export const leadSimpleLimiter = new RateLimiter(100, 100 / 60_000);
export const rentEngineLimiter = new RateLimiter(30, 30 / 60_000);
