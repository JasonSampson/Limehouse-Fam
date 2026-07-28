import { describe, it, expect } from "vitest";
import {
  summarizePropertyReadiness,
  propertyReadinessExplainRows,
  summarizeResidentResponseTime,
  residentResponseTimeExplainRows,
  RESIDENT_RESPONSE_ASSIGNEE_EMAIL,
  type LeadSimpleTask,
} from "../../src/leadsimple/client.js";

function task(overrides: Partial<LeadSimpleTask>): LeadSimpleTask {
  return {
    id: "t1",
    description: "Perform Final Zinpector Move In Inspection",
    kind: "todo",
    skipped: false,
    created_at: "2026-07-13T14:00:00Z", // Monday 10am EDT
    due_at: "2026-07-13T18:00:00Z", // Monday 2pm EDT
    completed_at: null,
    process: { id: "p1", name: "06 Move In Process for 123 Main St", process_type_id: "move-in-type", created_at: "2026-06-01T00:00:00Z" },
    assignee: { name: "Addison Winter", email: RESIDENT_RESPONSE_ASSIGNEE_EMAIL },
    ...overrides,
  };
}

describe("summarizePropertyReadiness", () => {
  it("counts a task completed by its due date as on time", () => {
    const tasks = [task({ due_at: "2026-07-13T18:00:00Z", completed_at: "2026-07-13T17:00:00Z" })];
    expect(summarizePropertyReadiness(tasks, "2026-07-01", "2026-07-31")).toEqual({ onTimeCount: 1, totalCount: 1, ratePercent: 100 });
  });

  it("counts a task completed after its due date as not on time", () => {
    const tasks = [task({ due_at: "2026-07-13T18:00:00Z", completed_at: "2026-07-14T18:00:00Z" })];
    expect(summarizePropertyReadiness(tasks, "2026-07-01", "2026-07-31")).toEqual({ onTimeCount: 0, totalCount: 1, ratePercent: 0 });
  });

  it("counts a task not yet completed as not on time (counts against the rate)", () => {
    const tasks = [task({ due_at: "2026-07-13T18:00:00Z", completed_at: null })];
    expect(summarizePropertyReadiness(tasks, "2026-07-01", "2026-07-31")).toEqual({ onTimeCount: 0, totalCount: 1, ratePercent: 0 });
  });

  it("excludes tasks due outside the window", () => {
    const tasks = [task({ due_at: "2026-05-01T00:00:00Z", completed_at: "2026-05-01T00:00:00Z" })];
    expect(summarizePropertyReadiness(tasks, "2026-07-01", "2026-07-31")).toEqual({ onTimeCount: 0, totalCount: 0, ratePercent: null });
  });

  it("excludes tasks with no due date at all", () => {
    const tasks = [task({ due_at: null, completed_at: "2026-07-13T18:00:00Z" })];
    expect(summarizePropertyReadiness(tasks, "2026-07-01", "2026-07-31")).toEqual({ onTimeCount: 0, totalCount: 0, ratePercent: null });
  });
});

describe("propertyReadinessExplainRows", () => {
  it("returns real formula inputs sorted newest-due-first", () => {
    const tasks = [
      task({ id: "t1", due_at: "2026-07-10T18:00:00Z", completed_at: "2026-07-10T17:00:00Z" }),
      task({ id: "t2", due_at: "2026-07-13T18:00:00Z", completed_at: "2026-07-14T18:00:00Z" }),
    ];
    const rows = propertyReadinessExplainRows(tasks, "2026-07-01", "2026-07-31");
    expect(rows).toEqual([
      {
        taskDescription: "Perform Final Zinpector Move In Inspection",
        processName: "06 Move In Process for 123 Main St",
        dueAt: "2026-07-13T18:00:00Z",
        completedAt: "2026-07-14T18:00:00Z",
        onTime: false,
        assignee: "Addison Winter",
      },
      {
        taskDescription: "Perform Final Zinpector Move In Inspection",
        processName: "06 Move In Process for 123 Main St",
        dueAt: "2026-07-10T18:00:00Z",
        completedAt: "2026-07-10T17:00:00Z",
        onTime: true,
        assignee: "Addison Winter",
      },
    ]);
  });
});

describe("summarizeResidentResponseTime", () => {
  it("computes average business hours across completed tasks", () => {
    // Monday 10am EDT created -> Monday 2pm EDT completed = 4 business hours.
    const tasks = [task({ created_at: "2026-07-13T14:00:00Z", completed_at: "2026-07-13T18:00:00Z" })];
    const result = summarizeResidentResponseTime(tasks, "2026-07-01", "2026-07-31");
    expect(result).toEqual({ averageHours: 4, withinCount: 1, totalCount: 1 });
  });

  it("excludes a task with no completion yet from the average", () => {
    const tasks = [task({ created_at: "2026-07-13T14:00:00Z", completed_at: null })];
    expect(summarizeResidentResponseTime(tasks, "2026-07-01", "2026-07-31")).toEqual({ averageHours: null, withinCount: 0, totalCount: 0 });
  });

  it("flags a task that took more than 24 business hours as not within", () => {
    // Monday 9am EDT created -> Wednesday 9am EDT completed = 16 business hours (Mon+Tue full days = 16h) -- within.
    // Use a longer span to exceed 24 business hours: Monday 9am -> Thursday 2pm = 3 full days (24h) + 5h = 29h -- not within.
    const tasks = [task({ created_at: "2026-07-13T13:00:00Z", completed_at: "2026-07-16T18:00:00Z" })];
    const result = summarizeResidentResponseTime(tasks, "2026-07-01", "2026-07-31");
    expect(result.withinCount).toBe(0);
    expect(result.totalCount).toBe(1);
  });
});

describe("residentResponseTimeExplainRows", () => {
  it("returns real formula inputs with business hours computed", () => {
    const tasks = [task({ created_at: "2026-07-13T14:00:00Z", completed_at: "2026-07-13T18:00:00Z", kind: "email" })];
    const rows = residentResponseTimeExplainRows(tasks, "2026-07-01", "2026-07-31");
    expect(rows).toEqual([
      {
        taskDescription: "Perform Final Zinpector Move In Inspection",
        kind: "email",
        startAt: "2026-07-13T14:00:00Z",
        completedAt: "2026-07-13T18:00:00Z",
        hours: 4,
        within24BusinessHours: true,
      },
    ]);
  });
});
