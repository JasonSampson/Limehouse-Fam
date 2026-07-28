import { describe, it, expect } from "vitest";
import {
  summarizeRenewalFollowUpTimeliness,
  renewalFollowUpTimelinessExplainRows,
  type LeadSimpleTask,
} from "../../src/leadsimple/client.js";

function task(overrides: Partial<LeadSimpleTask>): LeadSimpleTask {
  return {
    id: "t1",
    description: "Some renewal task",
    kind: "todo",
    skipped: false,
    created_at: "2026-07-01T00:00:00Z",
    due_at: "2026-07-10T00:00:00Z",
    completed_at: "2026-07-10T00:00:00Z",
    process: {
      id: "p1",
      name: "07 Lease Renewal Process for Test Address",
      process_type_id: "73a864ab-484c-405d-9def-5401a5134591",
      created_at: "2026-06-01T00:00:00Z",
      stage: { name: "Send Lease", status: "working" },
    },
    assignee: { name: "Belinda Jean Dabandan", email: "assistant@limehousepm.com" },
    ...overrides,
  };
}

describe("summarizeRenewalFollowUpTimeliness", () => {
  it("counts a todo task completed on its due date's calendar day as on time", () => {
    const tasks = [task({ due_at: "2026-07-10T09:00:00Z", completed_at: "2026-07-10T22:00:00Z" })];
    const result = summarizeRenewalFollowUpTimeliness(tasks, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ onTimeCount: 1, totalCount: 1, ratePercent: 100 });
  });

  it("counts a todo task completed the day after its due date as not on time", () => {
    const tasks = [task({ due_at: "2026-07-10T09:00:00Z", completed_at: "2026-07-11T00:05:00Z" })];
    const result = summarizeRenewalFollowUpTimeliness(tasks, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ onTimeCount: 0, totalCount: 1, ratePercent: 0 });
  });

  it("counts a task completed before its due date as on time regardless of the exact hour", () => {
    const tasks = [task({ due_at: "2026-07-10T09:00:00Z", completed_at: "2026-07-09T23:59:00Z" })];
    const result = summarizeRenewalFollowUpTimeliness(tasks, "2026-07-01", "2026-07-31");
    expect(result.onTimeCount).toBe(1);
  });

  it("excludes automated email-kind tasks from the population", () => {
    const tasks = [task({ kind: "email", completed_at: "2026-07-10T00:00:00Z" })];
    const result = summarizeRenewalFollowUpTimeliness(tasks, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ onTimeCount: 0, totalCount: 0, ratePercent: null });
  });

  // Process-type filtering happens one layer up, in fetchLeaseRenewalTasks
  // (same contract as fetchMoveInTasks/summarizePropertyReadiness) -- this
  // function trusts its input is already scoped to Lease Renewal Process
  // tasks, so it doesn't re-check process_type_id itself.

  it("scopes population by completed_at in window, not due_at (a still-open task due in window is excluded, not counted against)", () => {
    const tasks = [task({ due_at: "2026-07-15T00:00:00Z", completed_at: null })];
    const result = summarizeRenewalFollowUpTimeliness(tasks, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ onTimeCount: 0, totalCount: 0, ratePercent: null });
  });

  it("includes a task whose process was created outside the window as long as it completed inside it", () => {
    const tasks = [
      task({
        process: {
          id: "p1",
          name: "07 Lease Renewal Process for Old Process",
          process_type_id: "73a864ab-484c-405d-9def-5401a5134591",
          created_at: "2025-01-01T00:00:00Z",
          stage: { name: "Send Lease", status: "working" },
        },
        due_at: "2026-07-10T09:00:00Z",
        completed_at: "2026-07-10T22:00:00Z",
      }),
    ];
    const result = summarizeRenewalFollowUpTimeliness(tasks, "2026-07-01", "2026-07-31");
    expect(result.totalCount).toBe(1);
  });

  it("returns null rate when no tasks completed in window", () => {
    const result = summarizeRenewalFollowUpTimeliness([], "2026-07-01", "2026-07-31");
    expect(result).toEqual({ onTimeCount: 0, totalCount: 0, ratePercent: null });
  });
});

describe("renewalFollowUpTimelinessExplainRows", () => {
  it("returns real formula inputs including stage, sorted by completedAt descending", () => {
    const tasks = [
      task({ id: "a", description: "Task A", completed_at: "2026-07-05T00:00:00Z", due_at: "2026-07-05T00:00:00Z" }),
      task({ id: "b", description: "Task B", completed_at: "2026-07-15T00:00:00Z", due_at: "2026-07-10T00:00:00Z" }),
    ];
    const rows = renewalFollowUpTimelinessExplainRows(tasks, "2026-07-01", "2026-07-31");
    expect(rows.map((r) => r.taskDescription)).toEqual(["Task B", "Task A"]);
    expect(rows[0]).toMatchObject({ stage: "Send Lease", onTime: false, processName: "07 Lease Renewal Process for Test Address" });
  });

  it("omits a task not completed in the window", () => {
    const tasks = [task({ completed_at: null })];
    const rows = renewalFollowUpTimelinessExplainRows(tasks, "2026-07-01", "2026-07-31");
    expect(rows).toEqual([]);
  });
});
