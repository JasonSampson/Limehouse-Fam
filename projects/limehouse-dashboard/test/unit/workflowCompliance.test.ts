import { describe, it, expect } from "vitest";
import {
  summarizeWorkflowCompliance,
  workflowComplianceExplainRows,
  type LeadSimpleTask,
  type LeadSimpleProcess,
  type WorkflowComplianceData,
} from "../../src/leadsimple/client.js";

function process(overrides: Partial<LeadSimpleProcess>): LeadSimpleProcess {
  return {
    id: "p1",
    name: "05 Applications Process for Test Address",
    created_at: "2026-07-10T00:00:00Z",
    updated_at: "2026-07-10T00:00:00Z",
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
    description: "Some task",
    kind: "todo",
    skipped: false,
    created_at: "2026-07-10T00:00:00Z",
    due_at: "2026-07-11T20:00:00Z",
    completed_at: "2026-07-11T21:00:00Z",
    process: {
      id: "p1",
      name: "05 Applications Process for Test Address",
      process_type_id: "4785085c-d08b-4958-b32c-8d28b43ee020",
      created_at: "2026-07-10T00:00:00Z",
      stage: null,
    },
    assignee: { name: "Belinda Jean Dabandan", email: "assistant@limehousepm.com" },
    ...overrides,
  };
}

function data(processes: LeadSimpleProcess[], tasksByProcessId: Map<string, LeadSimpleTask[]>): WorkflowComplianceData {
  return {
    processes: processes.map((p) => ({ process: p, typeLabel: "05 Applications Process" })),
    tasksByProcessId,
  };
}

describe("summarizeWorkflowCompliance", () => {
  it("counts a process compliant when nothing is skipped or late, even with an incomplete task", () => {
    const p = process({ id: "p1" });
    const tasks = [
      task({ id: "a", completed_at: "2026-07-11T21:00:00Z" }),
      task({ id: "b", completed_at: null, due_at: "2026-08-01T00:00:00Z" }),
    ];
    const d = data([p], new Map([["p1", tasks]]));
    const result = summarizeWorkflowCompliance(d, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ compliantCount: 1, totalCount: 1, ratePercent: 100 });
  });

  it("counts a process not compliant when a task was completed after its due date", () => {
    const p = process({ id: "p1" });
    const tasks = [task({ due_at: "2026-07-10T22:00:00Z", completed_at: "2026-07-11T14:00:00Z" })];
    const d = data([p], new Map([["p1", tasks]]));
    const result = summarizeWorkflowCompliance(d, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ compliantCount: 0, totalCount: 1, ratePercent: 0 });
  });

  it("counts a process not compliant when a task was skipped, regardless of timing", () => {
    const p = process({ id: "p1" });
    const tasks = [task({ skipped: true, completed_at: null })];
    const d = data([p], new Map([["p1", tasks]]));
    const result = summarizeWorkflowCompliance(d, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ compliantCount: 0, totalCount: 1, ratePercent: 0 });
  });

  it("excludes a process created outside the window", () => {
    const p = process({ id: "p1", created_at: "2026-06-15T00:00:00Z" });
    const tasks = [task({})];
    const d = data([p], new Map([["p1", tasks]]));
    const result = summarizeWorkflowCompliance(d, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ compliantCount: 0, totalCount: 0, ratePercent: null });
  });

  // Assignee scoping (which tasks belong to Belinda) happens one layer up,
  // in fetchWorkflowComplianceData when building tasksByProcessId -- same
  // contract as fetchTaskCompletionTasks/fetchLeaseRenewalTasks -- so a
  // process with zero tasks in the map is simply not eligible.
  it("excludes a process with no tasks in the map at all", () => {
    const p = process({ id: "p1" });
    const d = data([p], new Map());
    const result = summarizeWorkflowCompliance(d, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ compliantCount: 0, totalCount: 0, ratePercent: null });
  });

  it("returns null rate when there are no eligible processes", () => {
    const result = summarizeWorkflowCompliance({ processes: [], tasksByProcessId: new Map() }, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ compliantCount: 0, totalCount: 0, ratePercent: null });
  });
});

describe("workflowComplianceExplainRows", () => {
  it("reports skipped/late/incomplete counts split correctly across buckets", () => {
    const p = process({ id: "p1", name: "05 Applications Process for 132 Filbert Street" });
    const tasks = [
      task({ id: "a", skipped: true, completed_at: null }),
      task({ id: "b", due_at: "2026-07-10T22:00:00Z", completed_at: "2026-07-11T14:00:00Z" }),
      task({ id: "c", completed_at: null, due_at: "2026-08-01T00:00:00Z" }),
      task({ id: "d", due_at: "2026-07-10T09:00:00Z", completed_at: "2026-07-10T22:00:00Z" }),
    ];
    const d = data([p], new Map([["p1", tasks]]));
    const rows = workflowComplianceExplainRows(d, "2026-07-01", "2026-07-31");
    expect(rows).toEqual([
      {
        processName: "05 Applications Process for 132 Filbert Street",
        processTypeLabel: "05 Applications Process",
        taskCount: 4,
        skippedCount: 1,
        lateCount: 1,
        incompleteCount: 1,
        compliant: false,
      },
    ]);
  });

  it("sorts rows alphabetically by process name", () => {
    const p1 = process({ id: "p1", name: "9117 Chesapeake Boulevard" });
    const p2 = process({ id: "p2", name: "132 Filbert Street" });
    const d = data(
      [p1, p2],
      new Map([
        ["p1", [task({ process: { id: "p1", name: "9117 Chesapeake Boulevard", process_type_id: "x", created_at: "2026-07-10T00:00:00Z", stage: null } })]],
        ["p2", [task({ process: { id: "p2", name: "132 Filbert Street", process_type_id: "x", created_at: "2026-07-10T00:00:00Z", stage: null } })]],
      ])
    );
    const rows = workflowComplianceExplainRows(d, "2026-07-01", "2026-07-31");
    expect(rows.map((r) => r.processName)).toEqual(["132 Filbert Street", "9117 Chesapeake Boulevard"]);
  });
});
