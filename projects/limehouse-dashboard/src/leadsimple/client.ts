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

// REBUILT 2026-07-26, per Jason directly, correcting the 2026-07-05
// formula above (kept in git history): CONFIRMED EXACT against a real
// vendor screenshot (Avg 245.8h, 6 applications) that population requires
// BOTH created_at AND closed_at to fall within the window -- not just
// closed_at. Verified live: of 20 real processes closed in the window,
// the 14 excluded from the vendor's real report were EVERY process
// created before the window started (real backlog closing out this
// period); the 6 included were exactly the ones both opened and finished
// within it. Per-record hours math (created_at to closed_at) was already
// correct -- confirmed exact, to the tenth of an hour, on all 6 real rows.
function inWindow(iso: string | null, from: Date, to: Date): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return d >= from && d <= to;
}

export function summarizeApplicationProcessingTime(
  processes: LeadSimpleProcess[],
  fromDate: string,
  toDate: string
): ApplicationProcessingTimeSummary {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const inRange = processes.filter((p) => inWindow(p.created_at, from, to) && inWindow(p.closed_at, from, to));
  if (inRange.length === 0) {
    return { averageHours: null, closedCount: 0 };
  }
  const totalHours = inRange.reduce((sum, p) => {
    const hours = (new Date(p.closed_at!).getTime() - new Date(p.created_at).getTime()) / (1000 * 60 * 60);
    return sum + hours;
  }, 0);
  return { averageHours: roundPercent(totalHours / inRange.length), closedCount: inRange.length };
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
    .filter((p) => inWindow(p.created_at, from, to) && inWindow(p.closed_at, from, to))
    .map((p) => ({
      applicationName: p.name,
      createdAt: p.created_at,
      closedAt: p.closed_at!,
      hours: roundPercent((new Date(p.closed_at!).getTime() - new Date(p.created_at).getTime()) / 36e5),
    }));
}

// Task shape shared by every task-based KPI (Applicant Response
// Timeliness, Property Readiness, Resident Response Time, Renewal
// Follow-Up Timeliness). LeadSimple's /tasks endpoint returns far more
// fields than this (deal, step, etc.) — zod silently strips anything not
// declared here, so only what these KPIs actually need is modeled.
// created_at/due_at/kind and process.name/assignee.email were ADDED
// 2026-07-20 for Property Readiness and Resident Response Time —
// confirmed live real fields on every task (e.g. real case: {kind:
// "email", due_at: "2026-07-21T17:13:43Z", assignee: {email:
// "addison@limehousepm.com"}, process: {name: "06 Move In Process for
// 8032 Van Patten Road"}}). process.stage — ADDED 2026-07-27 for Renewal
// Follow-Up Timeliness, CONFIRMED LIVE present on every real task's
// nested process object (e.g. {name: "Send Lease", status: "working"}).
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
      stage: z.object({ name: z.string(), status: z.string() }).nullable().optional(),
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

// REBUILT 2026-07-26, per Jason directly, replacing the 2026-07-06 formula
// above (kept in git history, not this comment). CONFIRMED EXACT (to the
// tenth of an hour) against three real rows from the vendor's own real
// screenshot (2642 East Ocean View Ave A1: 212.2h; 1439 Simpson Court:
// 209.3h; 1149 Birks Lane: 429.1h) by pulling the real LeadSimple task
// records behind each one directly.
//
// This is NOT "time from application creation to its first action" (the
// old formula) — it's: of the tasks that got COMPLETED within the window,
// take the earliest one per Applications Process, and time THAT ONE TASK
// from when it was itself created (assigned) to when it was completed.
// Two consequences that surprised us, both confirmed against real data:
//   - The timed task is often nowhere near the start of the application —
//     e.g. Birks Lane's 429.1h was a "Charge Owner Leasing Fee" bookkeeping
//     task that didn't even exist until the lease was already signed; it's
//     just the first one whose OWN completion landed inside this window.
//   - A process only enters the population at all if something on it was
//     completed within the window — there's no more "created but never
//     responded to" case to separately count against the rate the way the
//     old created_at-cohort approach did.
// Population count still won't be pixel-exact against any single vendor
// screenshot moment (confirmed live 2026-07-26: ours read 34/67.6% against
// a screenshot showing 30/60% taken under an hour earlier) — real,
// continuously-changing live data, same tolerance already accepted for
// every other live-computed KPI on this dashboard.
export function summarizeApplicantResponseTimeliness(
  processes: LeadSimpleProcess[],
  tasksByProcessId: Map<string, LeadSimpleTask[]>,
  fromDate: string,
  toDate: string
): ApplicantResponseTimelinessSummary {
  const firstInWindow = firstTaskCompletedInWindowByProcess(processes, tasksByProcessId, fromDate, toDate);
  if (firstInWindow.size === 0) {
    return { withinCount: 0, totalCount: 0, ratePercent: null };
  }
  let withinCount = 0;
  for (const task of firstInWindow.values()) {
    const hours = (new Date(task.completed_at!).getTime() - new Date(task.created_at).getTime()) / 36e5;
    if (hours <= 24) withinCount++;
  }
  return {
    withinCount,
    totalCount: firstInWindow.size,
    ratePercent: roundPercent((withinCount / firstInWindow.size) * 100),
  };
}

// For each process, the earliest-completed task whose completed_at itself
// falls within [fromDate, toDate] — not the earliest task ever, and not
// filtered by when the PROCESS was created. A process with nothing
// completed in the window is absent from the result entirely.
function firstTaskCompletedInWindowByProcess(
  processes: LeadSimpleProcess[],
  tasksByProcessId: Map<string, LeadSimpleTask[]>,
  fromDate: string,
  toDate: string
): Map<string, LeadSimpleTask> {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const result = new Map<string, LeadSimpleTask>();
  for (const process of processes) {
    const completedInWindow = (tasksByProcessId.get(process.id) ?? []).filter((t) => {
      if (!t.completed_at) return false;
      const c = new Date(t.completed_at);
      return c >= from && c <= to;
    });
    if (completedInWindow.length === 0) continue;
    completedInWindow.sort((a, b) => new Date(a.completed_at!).getTime() - new Date(b.completed_at!).getTime());
    result.set(process.id, completedInWindow[0]);
  }
  return result;
}

export interface ApplicantResponseTimelinessExplainRow {
  applicationName: string;
  firstTaskDescription: string | null;
  hoursToComplete: number;
  within24h: boolean;
  assignee: string | null;
}

export function applicantResponseTimelinessExplainRows(
  processes: LeadSimpleProcess[],
  tasksByProcessId: Map<string, LeadSimpleTask[]>,
  fromDate: string,
  toDate: string
): ApplicantResponseTimelinessExplainRow[] {
  const firstInWindow = firstTaskCompletedInWindowByProcess(processes, tasksByProcessId, fromDate, toDate);
  const processById = new Map(processes.map((p) => [p.id, p]));
  return [...firstInWindow.entries()]
    .map(([processId, task]) => {
      const hours = (new Date(task.completed_at!).getTime() - new Date(task.created_at).getTime()) / 36e5;
      return {
        applicationName: processById.get(processId)?.name ?? "Unknown",
        firstTaskDescription: task.description,
        hoursToComplete: roundPercent(hours),
        within24h: hours <= 24,
        assignee: task.assignee?.name ?? null,
      };
    })
    .sort((a, b) => a.applicationName.localeCompare(b.applicationName));
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
// Renewal Follow-Up Timeliness (Leasing Specialist) — ADDED 2026-07-27, per
// Jason directly. Previously showed "No data" (definition seeded but not
// wired, see docs/vendor-reference.md) — Jason's own description ("Completed
// tasks in Lease Renewal Process") wasn't specific enough to build against
// until a real vendor drill-down screenshot gave real rows to test against.
//
// CONFIRMED LIVE 2026-07-27, POPULATION exact: real "todo" tasks (excluding
// automated "email"/"process" kind tasks) on the 07 Lease Renewal Process
// whose completed_at falls in the window — NOT due_at in the window, the
// rule Property Readiness uses. Verified exact: 164 tasks, matching the
// vendor's real "133/164" denominator precisely.
//
// ON-TIME RULE — NOT vendor-confirmed exactly, per Jason directly
// ("Honestly, I don't know" when asked how LeadSimple/his team defines
// "on time" here): comparing a task's own due_at to completed_at down to
// the exact minute produces nonsense (~20% on-time) because many tasks'
// due_at gets reset close to their own completion, not the original
// deadline. The most defensible, explainable rule tested — "completed on
// or before the due date's calendar day" — landed closest to the vendor's
// real 81.1% at 76.2%, without inventing an arbitrary grace-period number
// nobody actually confirmed. Shipped as a disclosed approximation, same
// treatment as Property Readiness/Resident Response Time's own known,
// accepted discrepancies elsewhere in this file. Revisit if a narrower
// rule is ever confirmed.
export const LEASE_RENEWAL_TASK_KIND_INCLUDED = "todo";

export async function fetchLeaseRenewalTasks(windowStartDate: string): Promise<LeadSimpleResult<LeadSimpleTask[]>> {
  return withConnectionGuard(async () => {
    const sinceEpoch = Math.floor(new Date(windowStartDate).getTime() / 1000);
    const tasks = await fetchTasksUpdatedSince(sinceEpoch);
    return tasks.filter((t) => t.process?.process_type_id === LEASE_RENEWAL_PROCESS_TYPE_ID);
  });
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function renewalFollowUpPopulation(tasks: LeadSimpleTask[], fromDate: string, toDate: string): LeadSimpleTask[] {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  return tasks.filter(
    (t) => t.kind === LEASE_RENEWAL_TASK_KIND_INCLUDED && t.completed_at !== null && new Date(t.completed_at) >= from && new Date(t.completed_at) <= to
  );
}

function renewalFollowUpOnTime(t: LeadSimpleTask): boolean {
  return t.due_at !== null && dateOnly(t.completed_at!) <= dateOnly(t.due_at);
}

export interface RenewalFollowUpTimelinessSummary {
  onTimeCount: number;
  totalCount: number;
  ratePercent: number | null;
}

export function summarizeRenewalFollowUpTimeliness(
  tasks: LeadSimpleTask[],
  fromDate: string,
  toDate: string
): RenewalFollowUpTimelinessSummary {
  const population = renewalFollowUpPopulation(tasks, fromDate, toDate);
  if (population.length === 0) {
    return { onTimeCount: 0, totalCount: 0, ratePercent: null };
  }
  const onTimeCount = population.filter(renewalFollowUpOnTime).length;
  return {
    onTimeCount,
    totalCount: population.length,
    ratePercent: roundPercent((onTimeCount / population.length) * 100),
  };
}

export interface RenewalFollowUpTimelinessExplainRow {
  taskDescription: string | null;
  processName: string | null;
  stage: string | null;
  dueAt: string | null;
  completedAt: string;
  onTime: boolean;
  assignee: string | null;
}

export function renewalFollowUpTimelinessExplainRows(
  tasks: LeadSimpleTask[],
  fromDate: string,
  toDate: string
): RenewalFollowUpTimelinessExplainRow[] {
  return renewalFollowUpPopulation(tasks, fromDate, toDate)
    .map((t) => ({
      taskDescription: t.description,
      processName: t.process?.name ?? null,
      stage: t.process?.stage?.name ?? null,
      dueAt: t.due_at,
      completedAt: t.completed_at!,
      onTime: renewalFollowUpOnTime(t),
      assignee: t.assignee?.name ?? null,
    }))
    .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
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
