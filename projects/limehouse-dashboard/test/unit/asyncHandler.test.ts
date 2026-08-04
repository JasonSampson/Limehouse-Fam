import { describe, it, expect, vi } from "vitest";
import { asyncHandler } from "../../src/lib/asyncHandler.js";

// asyncHandler's returned RequestHandler doesn't return the internal
// fn(...).catch(next) chain (Express itself never awaits a route handler's
// return value either), so a plain `await handler(...)` can resolve before
// that chain has actually settled — a real difference between a synchronous
// throw and a returned-rejected-promise, since unwrapping a promise an
// async function returns costs one extra microtask tick. Flushing a tick
// after calling the handler mirrors how Express really drives it (fire the
// handler, let the event loop carry on) rather than asserting mid-flight.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("asyncHandler", () => {
  it("calls through to next() when the wrapped handler resolves normally, without an error", async () => {
    const next = vi.fn();
    const handler = asyncHandler(async (_req, res) => {
      (res as any).json({ ok: true });
    });
    const res = { json: vi.fn() };
    handler({} as any, res as any, next);
    await flush();
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });

  it("forwards a thrown error to next(err) instead of rejecting unhandled", async () => {
    const next = vi.fn();
    const boom = new Error("Buildium timed out");
    const handler = asyncHandler(async () => {
      throw boom;
    });
    handler({} as any, {} as any, next);
    await flush();
    expect(next).toHaveBeenCalledWith(boom);
  });

  it("forwards a rejected promise the same way as a thrown error", async () => {
    const next = vi.fn();
    const boom = new Error("database write rejected");
    const handler = asyncHandler(async () => Promise.reject(boom));
    handler({} as any, {} as any, next);
    await flush();
    expect(next).toHaveBeenCalledWith(boom);
  });

  it("never produces an unhandled rejection for a throwing handler", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const handler = asyncHandler(async () => {
        throw new Error("boom");
      });
      handler({} as any, {} as any, vi.fn());
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
