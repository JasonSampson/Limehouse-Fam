import { describe, it, expect } from "vitest";
import {
  summarizeLeasingResponseTime,
  leasingResponseTimeExplainRows,
  TASK_COMPLETION_ASSIGNEE_EMAIL,
  type LeadSimpleTask,
} from "../../src/leadsimple/client.js";

function task(overrides: Partial<LeadSimpleTask>): LeadSimpleTask {
  return {
    id: "t1",
    description: "Thanks for signing your Lease!",
    kind: "email",
    skipped: false,
    created_at: "2026-07-10T00:00:00Z",
    due_at: "2026-07-13T14:00:00Z", // Monday 10am EDT
    completed_at: "2026-07-13T18:00:00Z", // Monday 2pm EDT
    process: null,
    assignee: { name: "Belinda Jean Dabandan", email: TASK_COMPLETION_ASSIGNEE_EMAIL },
    ...overrides,
  };
}

describe("summarizeLeasingResponseTime", () => {
  it("computes average business hours from due_at to completed_at", () => {
    // Monday 10am EDT due -> Monday 2pm EDT completed = 4 business hours.
    const tasks = [task({ due_at: "2026-07-13T14:00:00Z", completed_at: "2026-07-13T18:00:00Z" })];
    const result = summarizeLeasingResponseTime(tasks, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ averageHours: 4, withinCount: 1, totalCount: 1 });
  });

  // CONFIRMED against the real vendor screenshot's own example row: a task
  // due Jul 21, completed Jul 20 (a day BEFORE its due date) reads 0 hours,
  // not negative -- businessHoursBetween already floors at 0 when end <=
  // start, so a task finished early costs Belinda nothing.
  it("floors at 0 hours for a task completed before its own due date", () => {
    const tasks = [task({ due_at: "2026-07-21T00:00:00Z", completed_at: "2026-07-20T12:00:00Z" })];
    const result = summarizeLeasingResponseTime(tasks, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ averageHours: 0, withinCount: 1, totalCount: 1 });
  });

  it("excludes a task with no completion yet from the average", () => {
    const tasks = [task({ due_at: "2026-07-13T14:00:00Z", completed_at: null })];
    expect(summarizeLeasingResponseTime(tasks, "2026-07-01", "2026-07-31")).toEqual({
      averageHours: null,
      withinCount: 0,
      totalCount: 0,
    });
  });

  it("scopes population by due_at in window, not completed_at", () => {
    const tasks = [task({ due_at: "2026-06-15T00:00:00Z", completed_at: "2026-07-05T00:00:00Z" })];
    expect(summarizeLeasingResponseTime(tasks, "2026-07-01", "2026-07-31")).toEqual({
      averageHours: null,
      withinCount: 0,
      totalCount: 0,
    });
  });

  it("flags a task that took more than 24 business hours as not within", () => {
    // Monday 9am EDT due -> Thursday 2pm EDT completed = 29 business hours.
    const tasks = [task({ due_at: "2026-07-13T13:00:00Z", completed_at: "2026-07-16T18:00:00Z" })];
    const result = summarizeLeasingResponseTime(tasks, "2026-07-01", "2026-07-31");
    expect(result.withinCount).toBe(0);
    expect(result.totalCount).toBe(1);
  });
});

describe("leasingResponseTimeExplainRows", () => {
  it("returns real formula inputs with business hours computed from due_at", () => {
    const tasks = [task({ due_at: "2026-07-13T14:00:00Z", completed_at: "2026-07-13T18:00:00Z", kind: "todo" })];
    const rows = leasingResponseTimeExplainRows(tasks, "2026-07-01", "2026-07-31");
    expect(rows).toEqual([
      {
        taskDescription: "Thanks for signing your Lease!",
        kind: "todo",
        startAt: "2026-07-13T14:00:00Z",
        completedAt: "2026-07-13T18:00:00Z",
        hours: 4,
        within24BusinessHours: true,
      },
    ]);
  });

  it("sorts rows by completedAt descending", () => {
    const tasks = [
      task({ id: "a", completed_at: "2026-07-05T00:00:00Z" }),
      task({ id: "b", completed_at: "2026-07-15T00:00:00Z" }),
    ];
    const rows = leasingResponseTimeExplainRows(tasks, "2026-07-01", "2026-07-31");
    expect(rows.map((r) => r.completedAt)).toEqual(["2026-07-15T00:00:00Z", "2026-07-05T00:00:00Z"]);
  });

  it("omits a task not completed at all", () => {
    const tasks = [task({ completed_at: null })];
    expect(leasingResponseTimeExplainRows(tasks, "2026-07-01", "2026-07-31")).toEqual([]);
  });
});
