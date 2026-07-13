import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// syncCallActivityForPeriod deliberately sleeps ~4.2s between prospects to
// respect RentEngine's confirmed 30 req/min rate limit — mock timers so
// this test suite doesn't actually take minutes to run.
vi.mock("../../src/rentengine/client.js", () => ({
  fetchProspects: vi.fn(),
  fetchCallsForProspect: vi.fn(),
  fetchMessagesForProspect: vi.fn(),
}));

import { fetchProspects, fetchCallsForProspect, fetchMessagesForProspect } from "../../src/rentengine/client.js";
import { syncCallActivityForPeriod } from "../../src/rentengine/callActivitySync.js";

const mockedFetchProspects = vi.mocked(fetchProspects);
const mockedFetchCalls = vi.mocked(fetchCallsForProspect);
const mockedFetchMessages = vi.mocked(fetchMessagesForProspect);

describe("syncCallActivityForPeriod", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("throws if the account id looks malformed rather than silently querying with it", async () => {
    await expect(syncCallActivityForPeriod("2026-07-01", "2026-07-31", "short")).rejects.toThrow(/account_id/);
  });

  it("throws if RentEngine is not connected", async () => {
    mockedFetchProspects.mockResolvedValue({ connected: false, data: null, error: null });
    await expect(
      syncCallActivityForPeriod("2026-07-01", "2026-07-31", "29a7815c-08a9-45df-a13a-f75376c95770")
    ).rejects.toThrow(/not connected/);
  });

  it("sums calls and counts only outbound messages across all prospects in the period", async () => {
    mockedFetchProspects.mockResolvedValue({
      connected: true,
      data: [
        { id: 1, name: "Test Prospect", status: "New", source: "Zillow", unit_of_interest: null, created_at: "2026-07-01T00:00:00Z" },
        { id: 2, name: "Test Prospect", status: "New", source: "Zillow", unit_of_interest: null, created_at: "2026-07-02T00:00:00Z" },
      ],
      error: null,
    });
    mockedFetchCalls.mockImplementation(async (prospectId: number) =>
      prospectId === 1 ? [{ id: 10 }, { id: 11 }] : [{ id: 12 }]
    );
    mockedFetchMessages.mockImplementation(async (prospectId: number) =>
      prospectId === 1
        ? [{ direction: "outbound" }, { direction: "inbound" }]
        : [{ direction: "outbound" }, { direction: null }]
    );

    const resultPromise = syncCallActivityForPeriod(
      "2026-07-01",
      "2026-07-31",
      "29a7815c-08a9-45df-a13a-f75376c95770"
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ prospectsScanned: 2, totalCalls: 3, outboundTexts: 2, errors: 0 });
  });

  it("counts a failed per-prospect fetch as an error without aborting the whole sync", async () => {
    mockedFetchProspects.mockResolvedValue({
      connected: true,
      data: [
        { id: 1, name: "Test Prospect", status: "New", source: "Zillow", unit_of_interest: null, created_at: "2026-07-01T00:00:00Z" },
        { id: 2, name: "Test Prospect", status: "New", source: "Zillow", unit_of_interest: null, created_at: "2026-07-02T00:00:00Z" },
      ],
      error: null,
    });
    mockedFetchCalls.mockImplementation(async (prospectId: number) => {
      if (prospectId === 1) throw new Error("simulated API failure");
      return [{ id: 20 }];
    });
    mockedFetchMessages.mockResolvedValue([{ direction: "outbound" }]);

    const resultPromise = syncCallActivityForPeriod(
      "2026-07-01",
      "2026-07-31",
      "29a7815c-08a9-45df-a13a-f75376c95770"
    );
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ prospectsScanned: 2, totalCalls: 1, outboundTexts: 1, errors: 1 });
  });

  it("returns zero counts for an empty prospect list", async () => {
    mockedFetchProspects.mockResolvedValue({ connected: true, data: [], error: null });
    const result = await syncCallActivityForPeriod(
      "2026-07-01",
      "2026-07-31",
      "29a7815c-08a9-45df-a13a-f75376c95770"
    );
    expect(result).toEqual({ prospectsScanned: 0, totalCalls: 0, outboundTexts: 0, errors: 0 });
  });
});
