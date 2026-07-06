import { z } from "zod";
import { loadEnv, isLeadSimpleConnected } from "../config/env.js";
import { logWarn } from "../lib/logger.js";

// REBUILT 2026-07-05 against LeadSimple's REAL REST API, confirmed live
// via docs Jason retrieved himself from https://app.leadsimple.com/api_docs
// (a page requiring login, not publicly fetchable — Jason screenshotted it
// directly). The base URL was wrong (LEADSIMPLE_BASE_URL was
// api.leadsimple.com/v1 — real base is api.leadsimple.com/rest, confirmed
// live: GET /rest/users returned real 200 data with the real API key
// already in .env). The three functions this file used to export
// (fetchStaffResponseTimes, fetchStaffTaskCompletion,
// fetchStaffWorkflowCompliance) were built against endpoint paths that do
// not exist on the real API (/staff/response-times etc. — confirmed 404
// against the real server) — removed entirely rather than patched.
export class LeadSimpleApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: string) {
    super(message);
    this.name = "LeadSimpleApiError";
  }
}

function leadSimpleHeaders(): Record<string, string> {
  const env = loadEnv();
  return {
    Authorization: `Bearer ${env.LEADSIMPLE_API_KEY}`,
    Accept: "application/json",
  };
}

async function leadSimpleGet<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, any>): Promise<T> {
  const env = loadEnv();
  const res = await fetch(`${env.LEADSIMPLE_BASE_URL}${path}`, { headers: leadSimpleHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "<no body>");
    throw new LeadSimpleApiError(`LeadSimple API error ${res.status} on ${path}`, res.status, body);
  }
  const json = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new LeadSimpleApiError(
      `LeadSimple API response for ${path} did not match expected shape: ${parsed.error.message}`,
      res.status,
      JSON.stringify(json)
    );
  }
  return parsed.data;
}

export interface LeadSimpleResult<T> {
  connected: boolean;
  data: T | null;
  error: string | null;
}

async function withConnectionGuard<T>(fn: () => Promise<T>): Promise<LeadSimpleResult<T>> {
  if (!isLeadSimpleConnected()) {
    return { connected: false, data: null, error: null };
  }
  try {
    const data = await fn();
    return { connected: true, data, error: null };
  } catch (err) {
    logWarn("LeadSimple call failed", { error: err instanceof Error ? err.message : String(err) });
    return { connected: true, data: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================================
// Process types / stages / processes — for Lease Renewal Rate.
// CONFIRMED LIVE 2026-07-05: the real "07 Lease Renewal Process" type has
// id 73a864ab-484c-405d-9def-5401a5134591 with these real stages:
// "Upcoming" (status: working), "Send Lease" (status: working),
// "Lease Renewed" (status: completed), "Owner Relisting" (canceled),
// "Owner Selling Property" (canceled), "Owner Terminating Management"
// (canceled), "Owner/Tenant Non-Renewal" (status: backlog, despite the
// name this is a real terminal non-renewal outcome, not a queue).
// Classification uses stage NAME, not the generic status field, since
// "backlog" for a real terminal outcome would be misleading to filter on.
export const LEASE_RENEWAL_PROCESS_TYPE_ID = "73a864ab-484c-405d-9def-5401a5134591";
const IN_PROGRESS_STAGE_NAMES = new Set(["Upcoming", "Send Lease"]);
const RENEWED_STAGE_NAME = "Lease Renewed";

const leadSimpleStageSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
});
export type LeadSimpleStage = z.infer<typeof leadSimpleStageSchema>;

const leadSimplePagedSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    data: z.array(itemSchema),
    meta: z.object({
      page_number: z.number(),
      total_count: z.number(),
      total_pages: z.number(),
      per_page: z.number(),
    }),
  });

export async function fetchProcessTypeStages(processTypeId: string): Promise<LeadSimpleResult<LeadSimpleStage[]>> {
  return withConnectionGuard(async () => {
    const result = await leadSimpleGet(`/process_types/${processTypeId}/stages`, leadSimplePagedSchema(leadSimpleStageSchema));
    return result.data;
  });
}

const leadSimpleProcessSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  tags: z.array(z.string()),
  stage: z
    .object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
    })
    .nullable(),
});
export type LeadSimpleProcess = z.infer<typeof leadSimpleProcessSchema>;

async function fetchAllProcessesForType(processTypeId: string): Promise<LeadSimpleProcess[]> {
  const all: LeadSimpleProcess[] = [];
  let page = 1;
  while (true) {
    const result = await leadSimpleGet(
      `/process_types/${processTypeId}/processes?limit=100&page=${page}`,
      leadSimplePagedSchema(leadSimpleProcessSchema)
    );
    all.push(...result.data);
    if (page >= result.meta.total_pages) break;
    page++;
  }
  // "example" tagged rows are real template/demo processes LeadSimple
  // seeds on every process type (CONFIRMED LIVE on the Lease Renewal
  // Process type) — excluded here once, not left for every caller to
  // remember to filter.
  return all.filter((p) => !p.tags.includes("example"));
}

export async function fetchLeaseRenewalProcesses(): Promise<LeadSimpleResult<LeadSimpleProcess[]>> {
  return withConnectionGuard(() => fetchAllProcessesForType(LEASE_RENEWAL_PROCESS_TYPE_ID));
}

// CONFIRMED LIVE 2026-07-05: real process type id for "05 Applications
// Process". Used for the Leasing Specialist's Application Processing Time
// KPI (created_at to closed_at, per Jason — no per-assignee scoping yet,
// same "showing all assignees" state as the other unscoped Leasing
// Specialist KPIs).
export const APPLICATIONS_PROCESS_TYPE_ID = "4785085c-d08b-4958-b32c-8d28b43ee020";

export async function fetchApplicationProcesses(): Promise<LeadSimpleResult<LeadSimpleProcess[]>> {
  return withConnectionGuard(() => fetchAllProcessesForType(APPLICATIONS_PROCESS_TYPE_ID));
}

export interface ApplicationProcessingTimeSummary {
  averageHours: number | null;
  closedCount: number;
}

// Application Processing Time — formula confirmed by Jason 2026-07-05:
// created_at to closed_at, across all closed Applications Process
// processes in the period. Still-open processes (closed_at null) are not
// counted — there's no processing time to measure yet.
export function summarizeApplicationProcessingTime(
  processes: LeadSimpleProcess[],
  fromDate: string,
  toDate: string
): ApplicationProcessingTimeSummary {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const closedInRange = processes.filter((p) => {
    if (!p.closed_at) return false;
    const closedAt = new Date(p.closed_at);
    return closedAt >= from && closedAt <= to;
  });
  if (closedInRange.length === 0) {
    return { averageHours: null, closedCount: 0 };
  }
  const totalHours = closedInRange.reduce((sum, p) => {
    const hours = (new Date(p.closed_at!).getTime() - new Date(p.created_at).getTime()) / (1000 * 60 * 60);
    return sum + hours;
  }, 0);
  return { averageHours: roundPercent(totalHours / closedInRange.length), closedCount: closedInRange.length };
}

export interface ApplicationProcessingTimeExplainRow {
  applicationName: string;
  createdAt: string;
  closedAt: string;
  hours: number;
}

export function applicationProcessingTimeExplainRows(
  processes: LeadSimpleProcess[],
  fromDate: string,
  toDate: string
): ApplicationProcessingTimeExplainRow[] {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  return processes
    .filter((p) => {
      if (!p.closed_at) return false;
      const closedAt = new Date(p.closed_at);
      return closedAt >= from && closedAt <= to;
    })
    .map((p) => ({
      applicationName: p.name,
      createdAt: p.created_at,
      closedAt: p.closed_at!,
      hours: roundPercent((new Date(p.closed_at!).getTime() - new Date(p.created_at).getTime()) / 36e5),
    }));
}

// Task shape for the Applicant Response Timeliness KPI. LeadSimple's
// /tasks endpoint returns far more fields than this (deal, step, kind,
// etc.) — zod silently strips anything not declared here, so only what
// this KPI actually needs is modeled.
const leadSimpleTaskSchema = z.object({
  id: z.string(),
  description: z.string().nullable(),
  completed_at: z.string().nullable(),
  process: z
    .object({
      id: z.string(),
      process_type_id: z.string(),
      created_at: z.string(),
    })
    .nullable(),
  assignee: z.object({ name: z.string() }).nullable(),
});
export type LeadSimpleTask = z.infer<typeof leadSimpleTaskSchema>;

// CONFIRMED LIVE 2026-07-06: /tasks?process_id=X (and every other param
// name tried: processId, process, process_uuid) silently ignores the
// filter and returns the full unfiltered set — there is no way to ask the
// API directly for "tasks on process X". The only real, working filter is
// updated_since (unix seconds) — confirmed live to genuinely narrow
// results (e.g. total_count dropped from 56,818 to 6,130 for a 90-day
// cutoff). Since completing a task bumps its updated_at, any task that
// completed at or after `sinceEpochSeconds` is guaranteed to show up here
// — we then do the process-id matching ourselves, client-side.
async function fetchTasksUpdatedSince(sinceEpochSeconds: number): Promise<LeadSimpleTask[]> {
  const all: LeadSimpleTask[] = [];
  let page = 1;
  while (true) {
    const result = await leadSimpleGet(
      `/tasks?page=${page}&updated_since=${sinceEpochSeconds}`,
      leadSimplePagedSchema(leadSimpleTaskSchema)
    );
    all.push(...result.data);
    if (page >= result.meta.total_pages) break;
    page++;
  }
  return all;
}

function groupTasksByProcessId(tasks: LeadSimpleTask[], processTypeId: string): Map<string, LeadSimpleTask[]> {
  const map = new Map<string, LeadSimpleTask[]>();
  for (const t of tasks) {
    if (t.process?.process_type_id !== processTypeId) continue;
    const pid = t.process.id;
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid)!.push(t);
  }
  return map;
}

export interface ApplicationsWithTasks {
  processes: LeadSimpleProcess[];
  tasksByProcessId: Map<string, LeadSimpleTask[]>;
}

// Fetches everything summarizeApplicantResponseTimeliness/
// applicantResponseTimelinessExplainRows need in one place: every
// Applications Process ever created, plus a task set wide enough to cover
// first-task-completion for anything created since `windowStartDate`.
export async function fetchApplicationsWithTasksForResponseTimeliness(
  windowStartDate: string
): Promise<LeadSimpleResult<ApplicationsWithTasks>> {
  return withConnectionGuard(async () => {
    const processes = await fetchAllProcessesForType(APPLICATIONS_PROCESS_TYPE_ID);
    const sinceEpoch = Math.floor(new Date(windowStartDate).getTime() / 1000);
    const tasks = await fetchTasksUpdatedSince(sinceEpoch);
    const tasksByProcessId = groupTasksByProcessId(tasks, APPLICATIONS_PROCESS_TYPE_ID);
    return { processes, tasksByProcessId };
  });
}

export interface ApplicantResponseTimelinessSummary {
  withinCount: number;
  totalCount: number;
  ratePercent: number | null;
}

// CONFIRMED LIVE 2026-07-06 against the vendor's own drill-down data: for
// each Applications Process, find whichever of its tasks completed FIRST
// (earliest completed_at, regardless of what the task is), and check
// whether that happened within 24 hours of the process's created_at.
//
// POPULATION — deliberate, approved divergence from the vendor's own
// number: the vendor's live "(90d)" report also sweeps in old,
// already-closed applications (some from 2023) whenever some unrelated
// administrative task (most commonly a Bookkeeper "Charge Owner Leasing
// Fee" cleanup task, done months or years after the application closed)
// happens to be that process's earliest-completed task on record. That
// inflates "hours to complete" into the hundreds/thousands and drags the
// score down with backlog noise that has nothing to do with how fast staff
// respond to a CURRENT applicant. Jason confirmed 2026-07-06: score only
// applications actually created within the window. Expect this to read
// higher than the vendor's own snapshot whenever that backlog noise is
// present — that's the point, not a bug.
export function summarizeApplicantResponseTimeliness(
  processes: LeadSimpleProcess[],
  tasksByProcessId: Map<string, LeadSimpleTask[]>,
  fromDate: string,
  toDate: string
): ApplicantResponseTimelinessSummary {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const inWindow = processes.filter((p) => {
    const c = new Date(p.created_at);
    return c >= from && c <= to;
  });
  if (inWindow.length === 0) {
    return { withinCount: 0, totalCount: 0, ratePercent: null };
  }
  let withinCount = 0;
  for (const process of inWindow) {
    const firstCompleted = firstCompletedTask(tasksByProcessId.get(process.id) ?? []);
    if (!firstCompleted) continue; // no response yet -- counts against the rate, not toward it
    const hours = (new Date(firstCompleted.completed_at!).getTime() - new Date(process.created_at).getTime()) / 36e5;
    if (hours <= 24) withinCount++;
  }
  return {
    withinCount,
    totalCount: inWindow.length,
    ratePercent: roundPercent((withinCount / inWindow.length) * 100),
  };
}

function firstCompletedTask(tasks: LeadSimpleTask[]): LeadSimpleTask | null {
  const completed = tasks.filter((t) => t.completed_at !== null);
  if (completed.length === 0) return null;
  completed.sort((a, b) => new Date(a.completed_at!).getTime() - new Date(b.completed_at!).getTime());
  return completed[0];
}

export interface ApplicantResponseTimelinessExplainRow {
  applicationName: string;
  firstTaskDescription: string | null;
  hoursToComplete: number | null;
  within24h: boolean | null;
  assignee: string | null;
}

export function applicantResponseTimelinessExplainRows(
  processes: LeadSimpleProcess[],
  tasksByProcessId: Map<string, LeadSimpleTask[]>,
  fromDate: string,
  toDate: string
): ApplicantResponseTimelinessExplainRow[] {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  return processes
    .filter((p) => {
      const c = new Date(p.created_at);
      return c >= from && c <= to;
    })
    .map((process) => {
      const first = firstCompletedTask(tasksByProcessId.get(process.id) ?? []);
      if (!first) {
        return {
          applicationName: process.name,
          firstTaskDescription: null,
          hoursToComplete: null,
          within24h: null,
          assignee: null,
        };
      }
      const hours = (new Date(first.completed_at!).getTime() - new Date(process.created_at).getTime()) / 36e5;
      return {
        applicationName: process.name,
        firstTaskDescription: first.description,
        hoursToComplete: roundPercent(hours),
        within24h: hours <= 24,
        assignee: first.assignee?.name ?? null,
      };
    });
}

export interface LeaseRenewalRateSummary {
  renewedCount: number;
  decidedCount: number;
  ratePercent: number | null;
}

function roundPercent(n: number): number {
  return Math.round(n * 10) / 10;
}

// Rate = renewed / decided over the trailing window, where "decided"
// excludes still-in-progress processes and uses each process's updated_at
// (the date it reached its current stage) as the decision date — a
// process still sitting in "Upcoming"/"Send Lease" was correctly never
// counted either way. VERIFIED LIVE 2026-07-05: this produces 70.9%
// company-wide (144 renewed / 203 decided) over a trailing-12-month
// window — close to the Dashboard's own company-wide Renewal Rate
// (70.6%/70.8%) but NOT Jason's reported 61.9% for this specific Team
// Performance KPI. OPEN QUESTION, not yet resolved: Team Performance
// scores individual people (CEO View shows "3 people" under Portfolio
// Manager) — 61.9% may need to be scoped to one specific portfolio
// manager's leases/properties rather than company-wide. Do not wire this
// into a Team Performance KPI definition until that scoping question is
// answered — the company-wide math here is confirmed correct, but which
// population to run it against for THIS specific KPI is not yet confirmed.
export function summarizeLeaseRenewalRate(processes: LeadSimpleProcess[], fromDate: string, toDate: string): LeaseRenewalRateSummary {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const decided = processes.filter((p) => {
    if (!p.stage || IN_PROGRESS_STAGE_NAMES.has(p.stage.name)) return false;
    const decidedAt = new Date(p.updated_at);
    return decidedAt >= from && decidedAt <= to;
  });
  const renewed = decided.filter((p) => p.stage?.name === RENEWED_STAGE_NAME);
  return {
    renewedCount: renewed.length,
    decidedCount: decided.length,
    ratePercent: decided.length > 0 ? roundPercent((renewed.length / decided.length) * 100) : null,
  };
}
