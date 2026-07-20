import { z } from "zod";
import { loadEnv, isLeadSimpleConnected } from "../config/env.js";
import { logWarn } from "../lib/logger.js";
import { businessHoursBetween } from "../kpi/businessHours.js";

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

// `properties` — ADDED 2026-07-10 for the terminated-properties feature.
// CONFIRMED LIVE: the real API response carries a full properties[] array
// (address/city/state/zip/unit) on every process, previously silently
// stripped by zod since no caller needed it before now. `address` matches
// Buildium's Address.AddressLine1 format exactly (confirmed against 15
// real properties).
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
  properties: z.array(z.object({ address: z.string().nullable() })).default([]),
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

// CONFIRMED LIVE 2026-07-12: real process type id for "04 Marketing
// Process" — used for the Apps Per Vacancy drill-down to anchor a real
// vacancy cycle that predates Buildium's own lease history for a unit
// (see src/kpi/vacancyApplications.ts). This process type has existed
// since 2022-06-16 — real records don't and can't reach back further than
// that, since the workflow itself didn't exist before then.
export const MARKETING_PROCESS_TYPE_ID = "b8241168-fd3c-46fe-ae44-4f242beab643";

export async function fetchMarketingProcesses(): Promise<LeadSimpleResult<LeadSimpleProcess[]>> {
  return withConnectionGuard(() => fetchAllProcessesForType(MARKETING_PROCESS_TYPE_ID));
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

// Task shape shared by every task-based KPI (Applicant Response
// Timeliness, Property Readiness, Resident Response Time). LeadSimple's
// /tasks endpoint returns far more fields than this (deal, step, etc.) —
// zod silently strips anything not declared here, so only what these KPIs
// actually need is modeled. created_at/due_at/kind and process.name/
// assignee.email were ADDED 2026-07-20 for Property Readiness and
// Resident Response Time — confirmed live real fields on every task
// (e.g. real case: {kind: "email", due_at: "2026-07-21T17:13:43Z",
// assignee: {email: "addison@limehousepm.com"}, process: {name: "06 Move
// In Process for 8032 Van Patten Road"}}).
const leadSimpleTaskSchema = z.object({
  id: z.string(),
  description: z.string().nullable(),
  kind: z.string(),
  created_at: z.string(),
  due_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  process: z
    .object({
      id: z.string(),
      name: z.string(),
      process_type_id: z.string(),
      created_at: z.string(),
    })
    .nullable(),
  assignee: z.object({ name: z.string(), email: z.string() }).nullable(),
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

// CONFIRMED LIVE 2026-07-06 against the vendor's own real drill-down data
// (manually counted and matched exactly: 73 renewed / 118 decided = 61.9%):
// the trailing-12-month WINDOW is scoped by each process's created_at (when
// the renewal process itself started), not updated_at. "Decided" then means
// any process in that population whose stage isn't Upcoming/Send Lease —
// this includes "Owner/Tenant Non-Renewal" (backlog status) processes even
// though those show no real closed_at ("still open" in the vendor's own
// table), confirmed by the real vendor data: only counting created_at
// within the window (regardless of closed_at) reproduces 118 decided
// exactly. "Renewed" = a completed Lease Renewed outcome. The earlier
// updated_at-based version produced 70.9% company-wide (144/203) — close
// to the Dashboard's own separate Renewal Rate tile, but wrong for this
// specific KPI, which needed created_at scoping instead.
export function summarizeLeaseRenewalRate(processes: LeadSimpleProcess[], fromDate: string, toDate: string): LeaseRenewalRateSummary {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const decided = processes.filter((p) => {
    if (!p.stage || IN_PROGRESS_STAGE_NAMES.has(p.stage.name)) return false;
    const createdAt = new Date(p.created_at);
    return createdAt >= from && createdAt <= to;
  });
  const renewed = decided.filter((p) => p.stage?.name === RENEWED_STAGE_NAME);
  return {
    renewedCount: renewed.length,
    decidedCount: decided.length,
    ratePercent: decided.length > 0 ? roundPercent((renewed.length / decided.length) * 100) : null,
  };
}

export interface LeaseRenewalRateExplainRow {
  processName: string;
  stage: string | null;
  // status — ADDED 2026-07-19, per Jason directly, against a real vendor
  // screenshot: the vendor's own drill-down has a STATUS column (real
  // values "working"/"completed"/"canceled"/"backlog", see the stage
  // schema comment above) distinct from Stage — was already fetched on
  // every process's stage sub-object, just never surfaced here.
  status: string | null;
  createdAt: string;
  closedAt: string | null;
  renewed: boolean;
}

export function leaseRenewalRateExplainRows(
  processes: LeadSimpleProcess[],
  fromDate: string,
  toDate: string
): LeaseRenewalRateExplainRow[] {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  return processes
    .filter((p) => {
      const createdAt = new Date(p.created_at);
      return createdAt >= from && createdAt <= to;
    })
    .map((p) => ({
      processName: p.name,
      stage: p.stage?.name ?? null,
      status: p.stage?.status ?? null,
      createdAt: p.created_at,
      closedAt: p.closed_at,
      renewed: p.stage?.name === RENEWED_STAGE_NAME,
    }))
    // Newest first — matches the vendor's own real drill-down ordering,
    // confirmed against a real screenshot (2026-07-19).
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ============================================================================
// Property Readiness (Portfolio Assistant) — ADDED 2026-07-20, per Jason
// directly, against a real vendor screenshot: of the tasks in LeadSimple's
// "06 Move In Process" workflow that were due in the window, what share
// were completed by their due date. Confirmed live real process type id
// via GET /process_types.
//
// KNOWN, ACCEPTED DISCREPANCY vs. the vendor's own number — same
// "deliberate divergence" posture as Applicant Response Timeliness above,
// not a bug: Jason's real vendor screenshot for (2026-07-01 - 2026-07-18)
// showed "76.1% on time (51/67)"; the equivalent live query here for
// (2026-07-01 - 2026-07-20), just 2 days wider, returns 232 tasks due
// in-window (9.9% on time) — restricting to only still-OPEN move-in
// processes narrows it to 137, still nowhere near 67. Investigated live
// 2026-07-20: no combination of open/closed process, unique-process-count,
// or narrower date window found reproduces the vendor's population size.
// The vendor's exact internal filter is undocumented and Jason doesn't
// have visibility into it either ("I'm not sure how to narrow that down
// because I don't know what the filter limits are") — per Jason directly,
// kept live as a real, honest number rather than reverted to "No data,"
// with this discrepancy disclosed rather than silently guessed away. If a
// narrower rule is ever confirmed (e.g. a specific task-name subset, or a
// shorter trailing window), revisit both the fetch and summarize functions
// below together.
// ============================================================================

export const MOVE_IN_PROCESS_TYPE_ID = "004d2402-f868-421d-b0de-4592c1083922";

// Same accepted imperfection as fetchApplicationsWithTasksForResponseTimeliness
// above: /tasks only supports a real updated_since filter (process_id is
// silently ignored server-side, confirmed live) — a task due in-window but
// untouched since before windowStartDate could be missed. windowStartDate
// should be the query's own `from` date, same as every other task-based KPI.
export async function fetchMoveInTasks(windowStartDate: string): Promise<LeadSimpleResult<LeadSimpleTask[]>> {
  return withConnectionGuard(async () => {
    const sinceEpoch = Math.floor(new Date(windowStartDate).getTime() / 1000);
    const tasks = await fetchTasksUpdatedSince(sinceEpoch);
    return tasks.filter((t) => t.process?.process_type_id === MOVE_IN_PROCESS_TYPE_ID);
  });
}

export interface PropertyReadinessSummary {
  onTimeCount: number;
  totalCount: number;
  ratePercent: number | null;
}

// A task counts as "on time" only if it has actually been completed by its
// due date. A task still open past its due date, or not yet due at all
// within the window, is scored by whether it's already late — matching the
// same "no data yet counts against the rate" posture already established
// for Applicant Response Timeliness above.
export function summarizePropertyReadiness(tasks: LeadSimpleTask[], fromDate: string, toDate: string): PropertyReadinessSummary {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const inWindow = tasks.filter((t) => t.due_at !== null && new Date(t.due_at) >= from && new Date(t.due_at) <= to);
  if (inWindow.length === 0) {
    return { onTimeCount: 0, totalCount: 0, ratePercent: null };
  }
  const onTimeCount = inWindow.filter((t) => t.completed_at !== null && new Date(t.completed_at) <= new Date(t.due_at!)).length;
  return {
    onTimeCount,
    totalCount: inWindow.length,
    ratePercent: roundPercent((onTimeCount / inWindow.length) * 100),
  };
}

export interface PropertyReadinessExplainRow {
  taskDescription: string | null;
  processName: string | null;
  dueAt: string;
  completedAt: string | null;
  onTime: boolean;
  assignee: string | null;
}

export function propertyReadinessExplainRows(
  tasks: LeadSimpleTask[],
  fromDate: string,
  toDate: string
): PropertyReadinessExplainRow[] {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  return tasks
    .filter((t) => t.due_at !== null && new Date(t.due_at) >= from && new Date(t.due_at) <= to)
    .map((t) => ({
      taskDescription: t.description,
      processName: t.process?.name ?? null,
      dueAt: t.due_at!,
      completedAt: t.completed_at,
      onTime: t.completed_at !== null && new Date(t.completed_at) <= new Date(t.due_at!),
      assignee: t.assignee?.name ?? null,
    }))
    .sort((a, b) => b.dueAt.localeCompare(a.dueAt));
}

// ============================================================================
// Resident Response Time (Portfolio Assistant) — ADDED 2026-07-20, per
// Jason directly, against a real vendor screenshot: how fast the Assistant
// Property Manager completes her own communication tasks, in real business
// hours (Mon-Fri 9am-5pm America/New_York, excluding US federal holidays —
// see src/kpi/businessHours.ts).
//
// Hardcoded to Addison's real LeadSimple email, matching the vendor's own
// literal behavior ("Communication tasks assigned to Addison") — this is
// tied to the specific person holding the Assistant Property Manager role
// today, not a role lookup. If that person changes, this constant needs a
// manual update (same known limitation already accepted for other
// per-person KPIs in this project).
//
// KNOWN, ACCEPTED DISCREPANCY vs. the vendor's own number, same posture as
// Property Readiness above: Jason's real vendor screenshot for
// (2026-07-01 - 2026-07-18) showed exactly 8 tasks ("Avg 5.5 hours -- 8/8
// within 24 biz hours"); the equivalent live query here for
// (2026-07-01 - 2026-07-20), just 2 days wider, returns 102-104 of
// Addison's completed email/todo/meet tasks. Investigated live
// 2026-07-20: broke her tasks down by process type (63 Move In, 29
// Marketing, 10 with no process, 2 Onboarding) — none of those subsets,
// nor any obvious task-description pattern, cleanly isolates a group of
// ~8. The vendor's exact internal filter is undocumented and Jason
// doesn't have visibility into it either. Per Jason directly, kept live
// as a real, honest number rather than reverted to "No data," with this
// discrepancy disclosed rather than silently guessed away.
export const RESIDENT_RESPONSE_ASSIGNEE_EMAIL = "addison@limehousepm.com";

// Confirmed live 2026-07-20: real task kinds seen in this account are
// todo/email/call/meet/sms/change_stage/process. change_stage and process
// are LeadSimple-automated, not something a person does. call/sms don't
// appear in Addison's real task queue in the sample checked — per Jason
// directly, only email/todo/meet count as "communication tasks" here.
const RESIDENT_RESPONSE_TASK_KINDS = new Set(["email", "todo", "meet"]);

export async function fetchResidentResponseTasks(windowStartDate: string): Promise<LeadSimpleResult<LeadSimpleTask[]>> {
  return withConnectionGuard(async () => {
    const sinceEpoch = Math.floor(new Date(windowStartDate).getTime() / 1000);
    const tasks = await fetchTasksUpdatedSince(sinceEpoch);
    return tasks.filter(
      (t) => t.assignee?.email === RESIDENT_RESPONSE_ASSIGNEE_EMAIL && RESIDENT_RESPONSE_TASK_KINDS.has(t.kind)
    );
  });
}

export interface ResidentResponseTimeSummary {
  averageHours: number | null;
  withinCount: number;
  totalCount: number;
}

// Only completed tasks contribute an elapsed time — an open task has no
// "hours to complete" yet, so (matching Days on Market/Application
// Processing Time's pattern above) it's excluded from the average rather
// than treated as 0 or infinite.
export function summarizeResidentResponseTime(
  tasks: LeadSimpleTask[],
  fromDate: string,
  toDate: string
): ResidentResponseTimeSummary {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const completed = tasks.filter((t) => {
    const createdAt = new Date(t.created_at);
    return t.completed_at !== null && createdAt >= from && createdAt <= to;
  });
  if (completed.length === 0) {
    return { averageHours: null, withinCount: 0, totalCount: 0 };
  }
  const hoursPerTask = completed.map((t) => businessHoursBetween(t.created_at, t.completed_at!));
  const withinCount = hoursPerTask.filter((h) => h <= 24).length;
  const averageHours = hoursPerTask.reduce((sum, h) => sum + h, 0) / hoursPerTask.length;
  return {
    averageHours: Math.round(averageHours * 10) / 10,
    withinCount,
    totalCount: completed.length,
  };
}

export interface ResidentResponseTimeExplainRow {
  taskDescription: string | null;
  kind: string;
  startAt: string;
  completedAt: string | null;
  hours: number | null;
  within24BusinessHours: boolean | null;
}

export function residentResponseTimeExplainRows(
  tasks: LeadSimpleTask[],
  fromDate: string,
  toDate: string
): ResidentResponseTimeExplainRow[] {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  return tasks
    .filter((t) => {
      const createdAt = new Date(t.created_at);
      return t.completed_at !== null && createdAt >= from && createdAt <= to;
    })
    .map((t) => {
      const hours = businessHoursBetween(t.created_at, t.completed_at!);
      return {
        taskDescription: t.description,
        kind: t.kind,
        startAt: t.created_at,
        completedAt: t.completed_at,
        hours: Math.round(hours * 10) / 10,
        within24BusinessHours: hours <= 24,
      };
    })
    .sort((a, b) => b.startAt.localeCompare(a.startAt));
}
