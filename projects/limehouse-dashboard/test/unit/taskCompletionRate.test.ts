import { describe, it, expect } from "vitest";
import {
  summarizeTaskCompletionRate,
  taskCompletionRateExplainRows,
  TASK_COMPLETION_ASSIGNEE_EMAIL,
  type LeadSimpleTask,
} from "../../src/leadsimple/client.js";

function task(overrides: Partial<LeadSimpleTask>): LeadSimpleTask {
  return {
    id: "t1",
    description: "Some admin task",
    kind: "todo",
    skipped: false,
    created_at: "2026-07-01T00:00:00Z",
    due_at: "2026-07-10T20:00:00Z",
    completed_at: "2026-07-10T21:00:00Z",
    process: {
      id: "p1",
      name: "05 Applications Process for Test Address",
      process_type_id: "05-apps",
      created_at: "2026-06-01T00:00:00Z",
      stage: null,
    },
    assignee: { name: "Belinda Jean Dabandan", email: TASK_COMPLETION_ASSIGNEE_EMAIL },
    ...overrides,
  };
}

describe("summarizeTaskCompletionRate", () => {
  it("counts a task completed the same calendar day as its due date as on time", () => {
    const tasks = [task({ due_at: "2026-07-10T09:00:00Z", completed_at: "2026-07-10T22:00:00Z" })];
    const result = summarizeTaskCompletionRate(tasks, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ onTimeCount: 1, totalCount: 1, ratePercent: 100 });
  });

  // CONFIRMED against the real vendor screenshot's own named example:
  // "Update Lease Fields" due 2026-06-30, completed 2026-07-01 -- a real
  // late task, correctly not on time.
  it("counts a task completed the day after its due date as not on time", () => {
    const tasks = [task({ due_at: "2026-06-30T22:46:13Z", completed_at: "2026-07-01T14:04:05Z" })];
    const result = summarizeTaskCompletionRate(tasks, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ onTimeCount: 0, totalCount: 1, ratePercent: 0 });
  });

  // Kind filtering (todo + process only, excluding email/change_stage)
  // happens one layer up, in fetchTaskCompletionTasks (same contract as
  // fetchLeaseRenewalTasks/fetchMoveInTasks) -- this function trusts its
  // input is already scoped, so it doesn't re-check kind itself.
  it("counts whatever tasks it's given as long as they completed in the window", () => {
    const tasks = [
      task({ id: "a", kind: "todo" }),
      task({ id: "b", kind: "process", description: null, process: null }),
    ];
    const result = summarizeTaskCompletionRate(tasks, "2026-07-01", "2026-07-31");
    expect(result.totalCount).toBe(2);
  });

  it("scopes population by completed_at in window, not due_at", () => {
    const tasks = [task({ due_at: "2026-07-15T00:00:00Z", completed_at: null })];
    const result = summarizeTaskCompletionRate(tasks, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ onTimeCount: 0, totalCount: 0, ratePercent: null });
  });

  it("returns null rate when no tasks completed in window", () => {
    const result = summarizeTaskCompletionRate([], "2026-07-01", "2026-07-31");
    expect(result).toEqual({ onTimeCount: 0, totalCount: 0, ratePercent: null });
  });
});

describe("taskCompletionRateExplainRows", () => {
  it("labels a task with no process as 'standalone', matching the vendor's own wording", () => {
    const tasks = [task({ process: null })];
    const rows = taskCompletionRateExplainRows(tasks, "2026-07-01", "2026-07-31");
    expect(rows[0].processName).toBe("standalone");
  });

  it("sorts rows by completedAt descending", () => {
    const tasks = [
      task({ id: "a", completed_at: "2026-07-05T00:00:00Z" }),
      task({ id: "b", completed_at: "2026-07-15T00:00:00Z" }),
    ];
    const rows = taskCompletionRateExplainRows(tasks, "2026-07-01", "2026-07-31");
    expect(rows.map((r) => r.completedAt)).toEqual(["2026-07-15T00:00:00Z", "2026-07-05T00:00:00Z"]);
  });

  it("omits a task not completed in the window", () => {
    const tasks = [task({ completed_at: null })];
    const rows = taskCompletionRateExplainRows(tasks, "2026-07-01", "2026-07-31");
    expect(rows).toEqual([]);
  });
});
