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
    properties: [],
    ...overrides,
  };
}

function task(overrides: Partial<LeadSimpleTask>): LeadSimpleTask {
  return {
    id: "t1",
    description: "Is this property already leased or in progress?",
    kind: "todo",
    skipped: false,
    created_at: "2026-06-01T00:00:00Z",
    due_at: null,
    completed_at: null,
    process: { id: "p1", name: "05 Applications Process for Test Address", process_type_id: "apps-type", created_at: "2026-06-01T00:00:00Z" },
    assignee: { name: "Belinda Jean Dabandan", email: "assistant@limehousepm.com" },
    ...overrides,
  };
}

// REBUILT 2026-07-26, per Jason directly, replacing the created_at-cohort
// formula these tests used to cover: CONFIRMED EXACT against 3 real vendor
// screenshot rows that the real formula is "of the tasks completed within
// the window, take the earliest one per Applications Process, and time
// THAT TASK from its own created_at to its own completed_at" -- not
// process.created_at to first-ever-completed-task, the old assumption.
describe("summarizeApplicantResponseTimeliness", () => {
  it("counts a process whose first-in-window task took <=24h to complete (task's own duration, not process age)", () => {
    const processes = [process({ id: "p1", created_at: "2020-01-01T00:00:00Z" })]; // ancient process
    const tasksByProcessId = new Map([
      ["p1", [task({ created_at: "2026-06-01T08:00:00Z", completed_at: "2026-06-01T10:00:00Z" })]], // 2h task duration
    ]);
    const result = summarizeApplicantResponseTimeliness(processes, tasksByProcessId, "2026-01-01", "2026-12-31");
    expect(result).toEqual({ withinCount: 1, totalCount: 1, ratePercent: 100 });
  });

  it("does not count a task that took more than 24h to complete", () => {
    const processes = [process({ id: "p1" })];
    const tasksByProcessId = new Map([
      ["p1", [task({ created_at: "2026-06-01T00:00:00Z", completed_at: "2026-06-04T00:00:00Z" })]], // 72h
    ]);
    const result = summarizeApplicantResponseTimeliness(processes, tasksByProcessId, "2026-01-01", "2026-12-31");
    expect(result).toEqual({ withinCount: 0, totalCount: 1, ratePercent: 0 });
  });

  // CONFIRMED LIVE 2026-07-26: an old, already-closed process (created years
  // before the window) whose only in-window activity is a much-later
  // administrative task DOES count now -- the vendor's own screenshot shows
  // exactly this pattern (a Bookkeeper "Charge Owner Leasing Fee" task, real
  // property, real 429.1h). Population is scoped by when a task COMPLETED,
  // not when the process was created.
  it("includes an old process if its first-in-window task completed within the window", () => {
    const processes = [process({ id: "old", created_at: "2023-01-10T20:55:00Z" })];
    const tasksByProcessId = new Map([
      [
        "old",
        [task({ created_at: "2026-06-22T17:34:08Z", completed_at: "2026-07-01T13:44:36Z", description: "Charge Owner Leasing Fee & Lockset/Rekey Fee - Bookkeeper" })],
      ],
    ]);
    const result = summarizeApplicantResponseTimeliness(processes, tasksByProcessId, "2026-07-01", "2026-07-26");
    expect(result.totalCount).toBe(1);
  });

  it("excludes a process entirely when it has no task completed within the window", () => {
    const processes = [process({ id: "p1" })];
    const tasksByProcessId = new Map([["p1", [task({ completed_at: null })]]]);
    const result = summarizeApplicantResponseTimeliness(processes, tasksByProcessId, "2026-01-01", "2026-12-31");
    expect(result).toEqual({ withinCount: 0, totalCount: 0, ratePercent: null });
  });

  it("excludes a task completed outside the window even if the process has one completed inside it", () => {
    const processes = [process({ id: "p1" })];
    const tasksByProcessId = new Map([
      [
        "p1",
        [
          task({ id: "outside", created_at: "2026-05-01T00:00:00Z", completed_at: "2026-05-02T00:00:00Z" }), // before window
          task({ id: "inside", created_at: "2026-06-10T00:00:00Z", completed_at: "2026-06-10T01:00:00Z" }), // in window, 1h
        ],
      ],
    ]);
    const result = summarizeApplicantResponseTimeliness(processes, tasksByProcessId, "2026-06-01", "2026-06-30");
    expect(result).toEqual({ withinCount: 1, totalCount: 1, ratePercent: 100 });
  });

  it("picks the earliest in-window completion among several, not just array order", () => {
    const processes = [process({ id: "p1" })];
    const tasksByProcessId = new Map([
      [
        "p1",
        [
          task({ id: "t2", created_at: "2026-06-04T00:00:00Z", completed_at: "2026-06-05T00:00:00Z" }), // later completion, 24h duration
          task({ id: "t1", created_at: "2026-06-01T00:00:00Z", completed_at: "2026-06-01T02:00:00Z" }), // earliest completion, 2h duration
        ],
      ],
    ]);
    const result = summarizeApplicantResponseTimeliness(processes, tasksByProcessId, "2026-01-01", "2026-12-31");
    // Earliest-completed ("t1") is the one timed: 2h, within 24h.
    expect(result).toEqual({ withinCount: 1, totalCount: 1, ratePercent: 100 });
  });

  it("returns null rate when no processes have any task completed in the window", () => {
    const result = summarizeApplicantResponseTimeliness([], new Map(), "2026-01-01", "2026-12-31");
    expect(result).toEqual({ withinCount: 0, totalCount: 0, ratePercent: null });
  });
});

describe("applicantResponseTimelinessExplainRows", () => {
  it("times the task itself (created to completed), not the process's age", () => {
    const processes = [process({ id: "p1", name: "05 Applications Process for 123 Main St", created_at: "2020-01-01T00:00:00Z" })];
    const tasksByProcessId = new Map([
      ["p1", [task({ created_at: "2026-06-01T00:00:00Z", completed_at: "2026-06-01T06:00:00Z", assignee: { name: "Belinda Jean Dabandan", email: "assistant@limehousepm.com" } })]],
    ]);
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

  it("omits a process entirely when it has no task completed in the window", () => {
    const processes = [process({ id: "p1" })];
    const rows = applicantResponseTimelinessExplainRows(processes, new Map(), "2026-01-01", "2026-12-31");
    expect(rows).toEqual([]);
  });

  it("sorts rows alphabetically by application name", () => {
    const processes = [
      process({ id: "p1", name: "05 Applications Process for Zebra Street" }),
      process({ id: "p2", name: "05 Applications Process for Atlas Avenue" }),
    ];
    const tasksByProcessId = new Map([
      ["p1", [task({ process: { id: "p1", name: "05 Applications Process for Zebra Street", process_type_id: "apps-type", created_at: "2026-06-01T00:00:00Z" }, completed_at: "2026-06-01T01:00:00Z" })]],
      ["p2", [task({ process: { id: "p2", name: "05 Applications Process for Atlas Avenue", process_type_id: "apps-type", created_at: "2026-06-01T00:00:00Z" }, completed_at: "2026-06-01T01:00:00Z" })]],
    ]);
    const rows = applicantResponseTimelinessExplainRows(processes, tasksByProcessId, "2026-01-01", "2026-12-31");
    expect(rows.map((r) => r.applicationName)).toEqual([
      "05 Applications Process for Atlas Avenue",
      "05 Applications Process for Zebra Street",
    ]);
  });
});
