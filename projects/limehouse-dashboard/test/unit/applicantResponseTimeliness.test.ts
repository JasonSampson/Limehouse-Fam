import { describe, it, expect } from "vitest";
import {
  summarizeApplicantResponseTimeliness,
  applicantResponseTimelinessExplainRows,
  type LeadSimpleProcess,
  type LeadSimpleTask,
} from "../../src/leadsimple/client.js";

function process(overrides: Partial<LeadSimpleProcess>): LeadSimpleProcess {
  return {
    id: "p1",
    name: "05 Applications Process for Test Address",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    closed_at: null,
    tags: [],
    stage: null,
    ...overrides,
  };
}

function task(overrides: Partial<LeadSimpleTask>): LeadSimpleTask {
  return {
    id: "t1",
    description: "Is this property already leased or in progress?",
    completed_at: null,
    process: { id: "p1", process_type_id: "apps-type", created_at: "2026-06-01T00:00:00Z" },
    assignee: { name: "Belinda Jean Dabandan" },
    ...overrides,
  };
}

describe("summarizeApplicantResponseTimeliness", () => {
  it("counts a process whose first completed task landed within 24h", () => {
    const processes = [process({ id: "p1", created_at: "2026-06-01T00:00:00Z" })];
    const tasksByProcessId = new Map([["p1", [task({ completed_at: "2026-06-01T10:00:00Z" })]]]);
    const result = summarizeApplicantResponseTimeliness(processes, tasksByProcessId, "2026-01-01", "2026-12-31");
    expect(result).toEqual({ withinCount: 1, totalCount: 1, ratePercent: 100 });
  });

  it("does not count a process whose first completed task landed after 24h", () => {
    const processes = [process({ id: "p1", created_at: "2026-06-01T00:00:00Z" })];
    const tasksByProcessId = new Map([["p1", [task({ completed_at: "2026-06-04T00:00:00Z" })]]]); // 72h
    const result = summarizeApplicantResponseTimeliness(processes, tasksByProcessId, "2026-01-01", "2026-12-31");
    expect(result).toEqual({ withinCount: 0, totalCount: 1, ratePercent: 0 });
  });

  it("treats a process with no completed task at all as not-within (counts against the rate)", () => {
    const processes = [process({ id: "p1", created_at: "2026-06-01T00:00:00Z" })];
    const tasksByProcessId = new Map([["p1", [task({ completed_at: null })]]]);
    const result = summarizeApplicantResponseTimeliness(processes, tasksByProcessId, "2026-01-01", "2026-12-31");
    expect(result).toEqual({ withinCount: 0, totalCount: 1, ratePercent: 0 });
  });

  it("picks the earliest-completed task among several, not just the first in array order", () => {
    const processes = [process({ id: "p1", created_at: "2026-06-01T00:00:00Z" })];
    const tasksByProcessId = new Map([
      [
        "p1",
        [
          task({ id: "t2", completed_at: "2026-06-05T00:00:00Z" }), // later
          task({ id: "t1", completed_at: "2026-06-01T02:00:00Z" }), // earliest -- 2h, within 24h
        ],
      ],
    ]);
    const result = summarizeApplicantResponseTimeliness(processes, tasksByProcessId, "2026-01-01", "2026-12-31");
    expect(result).toEqual({ withinCount: 1, totalCount: 1, ratePercent: 100 });
  });

  // Reproduces the real discrepancy found live 2026-07-06: an old,
  // already-closed process (created years before the window) whose only
  // recorded task activity is a much-later administrative cleanup task.
  // Population is scoped by process.created_at, so this process must be
  // excluded from the window entirely -- it should never drag the rate
  // down with stale backlog noise.
  it("excludes a process created outside the window even if it has a recently-completed task", () => {
    const processes = [process({ id: "old", created_at: "2023-01-10T20:55:00Z" })];
    const tasksByProcessId = new Map([
      ["old", [task({ completed_at: "2023-03-12T00:00:00Z", description: "Charge Owner Leasing Fee & Lockset/Rekey Fee - Bookkeeper" })]],
    ]);
    const result = summarizeApplicantResponseTimeliness(processes, tasksByProcessId, "2026-01-01", "2026-12-31");
    expect(result).toEqual({ withinCount: 0, totalCount: 0, ratePercent: null });
  });

  it("returns null rate when no processes fall in the window", () => {
    const result = summarizeApplicantResponseTimeliness([], new Map(), "2026-01-01", "2026-12-31");
    expect(result).toEqual({ withinCount: 0, totalCount: 0, ratePercent: null });
  });
});

describe("applicantResponseTimelinessExplainRows", () => {
  it("returns real formula inputs per application, including assignee and the task description", () => {
    const processes = [process({ id: "p1", name: "05 Applications Process for 123 Main St", created_at: "2026-06-01T00:00:00Z" })];
    const tasksByProcessId = new Map([["p1", [task({ completed_at: "2026-06-01T06:00:00Z", assignee: { name: "Belinda Jean Dabandan" } })]]]);
    const rows = applicantResponseTimelinessExplainRows(processes, tasksByProcessId, "2026-01-01", "2026-12-31");
    expect(rows).toEqual([
      {
        applicationName: "05 Applications Process for 123 Main St",
        firstTaskDescription: "Is this property already leased or in progress?",
        hoursToComplete: 6,
        within24h: true,
        assignee: "Belinda Jean Dabandan",
      },
    ]);
  });

  it("returns nulls for a process with no completed task yet", () => {
    const processes = [process({ id: "p1", created_at: "2026-06-01T00:00:00Z" })];
    const rows = applicantResponseTimelinessExplainRows(processes, new Map(), "2026-01-01", "2026-12-31");
    expect(rows).toEqual([
      { applicationName: "05 Applications Process for Test Address", firstTaskDescription: null, hoursToComplete: null, within24h: null, assignee: null },
    ]);
  });
});
