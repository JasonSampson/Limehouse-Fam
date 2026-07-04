import { z } from "zod";
import { loadEnv, isLeadSimpleConnected } from "../config/env.js";
import { logWarn } from "../lib/logger.js";

// This is a NEW read client, separate from
// late-rent-notices/src/integrations/leadSimpleSync.ts (which is a
// write-only no-op stub for logging contact attempts back to LeadSimple —
// not reusable here, wrong direction and no real credentials configured).
//
// RESEARCH NOTE: LeadSimple's public API reference was not available to
// verify at build time — Jason has not yet confirmed API access for this
// use case (see project brief). Same defensive pattern as
// src/rentengine/client.ts: every function here is guarded by
// isLeadSimpleConnected() and returns a clean "not connected" result
// instead of throwing when LEADSIMPLE_API_KEY is blank/absent.
//
// The endpoint paths and shapes below (/staff/response-times,
// /staff/task-completion, /staff/workflow-compliance) are a BEST-GUESS
// placeholder based on what the Team Performance KPIs tagged "LS" need
// (response-time, task-completion-rate, workflow-compliance-rate per staff
// member) — NOT confirmed against a real LeadSimple API response. Verify
// against real API docs/access before relying on this in production.
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

const staffResponseTimeSchema = z.object({
  staffId: z.string(),
  staffName: z.string(),
  role: z.string(),
  averageResponseTimeHours: z.number(),
  periodStart: z.string(),
  periodEnd: z.string(),
});
export type LeadSimpleStaffResponseTime = z.infer<typeof staffResponseTimeSchema>;

const staffTaskCompletionSchema = z.object({
  staffId: z.string(),
  staffName: z.string(),
  role: z.string(),
  tasksAssigned: z.number(),
  tasksCompleted: z.number(),
  completionRatePercent: z.number(),
  periodStart: z.string(),
  periodEnd: z.string(),
});
export type LeadSimpleStaffTaskCompletion = z.infer<typeof staffTaskCompletionSchema>;

const staffWorkflowComplianceSchema = z.object({
  staffId: z.string(),
  staffName: z.string(),
  role: z.string(),
  compliancePercent: z.number(),
  periodStart: z.string(),
  periodEnd: z.string(),
});
export type LeadSimpleStaffWorkflowCompliance = z.infer<typeof staffWorkflowComplianceSchema>;

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

export async function fetchStaffResponseTimes(
  fromDate: string,
  toDate: string
): Promise<LeadSimpleResult<LeadSimpleStaffResponseTime[]>> {
  return withConnectionGuard(() =>
    leadSimpleGet(
      `/staff/response-times?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`,
      z.array(staffResponseTimeSchema)
    )
  );
}

export async function fetchStaffTaskCompletion(
  fromDate: string,
  toDate: string
): Promise<LeadSimpleResult<LeadSimpleStaffTaskCompletion[]>> {
  return withConnectionGuard(() =>
    leadSimpleGet(
      `/staff/task-completion?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`,
      z.array(staffTaskCompletionSchema)
    )
  );
}

export async function fetchStaffWorkflowCompliance(
  fromDate: string,
  toDate: string
): Promise<LeadSimpleResult<LeadSimpleStaffWorkflowCompliance[]>> {
  return withConnectionGuard(() =>
    leadSimpleGet(
      `/staff/workflow-compliance?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`,
      z.array(staffWorkflowComplianceSchema)
    )
  );
}
