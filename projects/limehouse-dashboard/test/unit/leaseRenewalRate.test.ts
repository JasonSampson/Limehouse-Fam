import { describe, it, expect } from "vitest";
import { summarizeLeaseRenewalRate, summarizeApplicationProcessingTime, applicationProcessingTimeExplainRows, type LeadSimpleProcess } from "../../src/leadsimple/client.js";

function process(overrides: Partial<LeadSimpleProcess>): LeadSimpleProcess {
  return {
    id: "1",
    name: "05 Applications Process for Test Address",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-01-15T00:00:00Z",
    closed_at: null,
    tags: [],
    stage: { id: "s1", name: "Lease Renewed", status: "completed" },
    properties: [],
    ...overrides,
  };
}

describe("summarizeLeaseRenewalRate", () => {
  it("counts a completed Lease Renewed process as renewed and decided", () => {
    const result = summarizeLeaseRenewalRate(
      [process({ stage: { id: "s1", name: "Lease Renewed", status: "completed" } })],
      "2026-01-01",
      "2026-12-31"
    );
    expect(result).toEqual({ renewedCount: 1, decidedCount: 1, ratePercent: 100 });
  });

  it("counts a non-renewal outcome as decided but not renewed", () => {
    const result = summarizeLeaseRenewalRate(
      [process({ stage: { id: "s2", name: "Owner/Tenant Non-Renewal", status: "backlog" } })],
      "2026-01-01",
      "2026-12-31"
    );
    expect(result).toEqual({ renewedCount: 0, decidedCount: 1, ratePercent: 0 });
  });

  it("excludes still-in-progress stages (Upcoming, Send Lease) from decided entirely", () => {
    const result = summarizeLeaseRenewalRate(
      [
        process({ stage: { id: "s3", name: "Upcoming", status: "working" } }),
        process({ stage: { id: "s4", name: "Send Lease", status: "working" } }),
        process({ stage: { id: "s1", name: "Lease Renewed", status: "completed" } }),
      ],
      "2026-01-01",
      "2026-12-31"
    );
    expect(result.decidedCount).toBe(1);
    expect(result.renewedCount).toBe(1);
  });

  it("excludes a process created outside the requested date range", () => {
    const result = summarizeLeaseRenewalRate(
      [process({ stage: { id: "s1", name: "Lease Renewed", status: "completed" }, created_at: "2024-01-01T00:00:00Z" })],
      "2026-01-01",
      "2026-12-31"
    );
    expect(result.decidedCount).toBe(0);
    expect(result.ratePercent).toBeNull();
  });

  it("treats all four real non-renewal outcome stages as decided-not-renewed", () => {
    const outcomes = ["Owner Relisting", "Owner Selling Property", "Owner Terminating Management", "Owner/Tenant Non-Renewal"];
    const processes = outcomes.map((name, i) => process({ stage: { id: `s${i}`, name, status: "canceled" } }));
    const result = summarizeLeaseRenewalRate(processes, "2026-01-01", "2026-12-31");
    expect(result.decidedCount).toBe(4);
    expect(result.renewedCount).toBe(0);
  });

  // CONFIRMED LIVE 2026-07-06: the window scopes by created_at (when the
  // renewal process itself started), not updated_at — a process can be
  // "still open" (no real closed_at) for a non-renewal outcome like
  // Owner/Tenant Non-Renewal and still correctly count as decided, as long
  // as it was CREATED inside the window. Reproduces the real vendor number
  // exactly: 73 renewed / 118 decided = 61.9%.
  it("counts a still-open Owner/Tenant Non-Renewal process as decided based on created_at, ignoring closed_at", () => {
    const result = summarizeLeaseRenewalRate(
      [
        process({
          stage: { id: "s1", name: "Owner/Tenant Non-Renewal", status: "backlog" },
          created_at: "2026-03-01T00:00:00Z",
          closed_at: null,
        }),
      ],
      "2026-01-01",
      "2026-12-31"
    );
    expect(result).toEqual({ renewedCount: 0, decidedCount: 1, ratePercent: 0 });
  });
});

describe("summarizeApplicationProcessingTime", () => {
  it("averages closed_at minus created_at in hours across processes closed in the period", () => {
    const processes = [
      process({ created_at: "2026-06-01T00:00:00Z", closed_at: "2026-06-03T00:00:00Z" }), // 48h
      process({ created_at: "2026-06-05T00:00:00Z", closed_at: "2026-06-06T00:00:00Z" }), // 24h
    ];
    const result = summarizeApplicationProcessingTime(processes, "2026-06-01", "2026-06-30");
    expect(result).toEqual({ averageHours: 36, closedCount: 2 });
  });

  it("excludes a still-open process (closed_at null) from the average", () => {
    const processes = [
      process({ created_at: "2026-06-01T00:00:00Z", closed_at: "2026-06-02T00:00:00Z" }), // 24h
      process({ created_at: "2026-06-10T00:00:00Z", closed_at: null }),
    ];
    const result = summarizeApplicationProcessingTime(processes, "2026-06-01", "2026-06-30");
    expect(result).toEqual({ averageHours: 24, closedCount: 1 });
  });

  it("excludes a process closed outside the requested date range", () => {
    const processes = [process({ created_at: "2026-05-01T00:00:00Z", closed_at: "2026-05-02T00:00:00Z" })];
    const result = summarizeApplicationProcessingTime(processes, "2026-06-01", "2026-06-30");
    expect(result).toEqual({ averageHours: null, closedCount: 0 });
  });

  // REBUILT 2026-07-26, per Jason directly, confirmed exact against a real
  // vendor screenshot (Avg 245.8h across 6 real applications): a process
  // created BEFORE the window but closed inside it (real backlog closing
  // out this period) must be excluded, even though the old formula counted
  // it -- population requires created_at AND closed_at both in range.
  it("excludes a process created before the window even though it closed inside it", () => {
    const processes = [
      process({ created_at: "2026-05-15T00:00:00Z", closed_at: "2026-06-10T00:00:00Z" }), // created before window
      process({ created_at: "2026-06-02T00:00:00Z", closed_at: "2026-06-05T00:00:00Z" }), // both in window, 72h
    ];
    const result = summarizeApplicationProcessingTime(processes, "2026-06-01", "2026-06-30");
    expect(result).toEqual({ averageHours: 72, closedCount: 1 });
  });
});

describe("applicationProcessingTimeExplainRows", () => {
  it("omits a process created before the window even though it closed inside it", () => {
    const processes = [
      process({ name: "Old backlog", created_at: "2026-05-15T00:00:00Z", closed_at: "2026-06-10T00:00:00Z" }),
      process({ name: "Real this period", created_at: "2026-06-02T00:00:00Z", closed_at: "2026-06-05T00:00:00Z" }),
    ];
    const rows = applicationProcessingTimeExplainRows(processes, "2026-06-01", "2026-06-30");
    expect(rows).toEqual([
      { applicationName: "Real this period", createdAt: "2026-06-02T00:00:00Z", closedAt: "2026-06-05T00:00:00Z", hours: 72 },
    ]);
  });
});
