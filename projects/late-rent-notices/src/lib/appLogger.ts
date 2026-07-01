// Application logger. Hard rule (Sentinel + CLAUDE.md): application logs
// must NEVER contain full tenant PII (names, addresses, dollar amounts).
// Log identifiers/trace IDs only — full detail belongs in audit_log, which
// has its own access controls (INSERT-only, no UPDATE/DELETE for the app).
//
// This is intentionally a thin wrapper, not a logging framework, to keep
// the "what's allowed in here" surface small and obvious at a glance.
export interface LogFields {
  traceId?: string;
  spanId?: string;
  noticeId?: number;
  leaseId?: number;
  jobName?: string;
  [key: string]: unknown;
}

// Fields explicitly declared in LogFields above are reviewed-safe by
// construction (identifiers/trace IDs only, no PII) — the substring check
// below only needs to police OTHER, ad-hoc keys callers pass through the
// index signature. Without this allowlist, a substring check alone flags
// legitimate fields like "jobName" (contains "name") as if they were a
// person's name, which previously caused logError to throw on its own
// field name instead of logging the actual error it was trying to report.
const ALLOWED_KEYS = new Set(["traceId", "spanId", "noticeId", "leaseId", "jobName"]);

function assertNoPii(fields: LogFields): void {
  const forbiddenKeys = ["name", "email", "amount", "balance", "address", "tenant", "fullName", "fullname"];
  for (const key of Object.keys(fields)) {
    if (ALLOWED_KEYS.has(key)) continue;
    const lower = key.toLowerCase();
    if (forbiddenKeys.some((f) => lower.includes(f))) {
      throw new Error(
        `appLogger: refusing to log field "${key}" — looks like tenant PII. Use auditLog instead.`
      );
    }
  }
}

export function logInfo(message: string, fields: LogFields = {}): void {
  assertNoPii(fields);
  console.log(JSON.stringify({ level: "info", message, ...fields, ts: new Date().toISOString() }));
}

export function logError(message: string, fields: LogFields = {}): void {
  assertNoPii(fields);
  console.error(JSON.stringify({ level: "error", message, ...fields, ts: new Date().toISOString() }));
}

export function logWarn(message: string, fields: LogFields = {}): void {
  assertNoPii(fields);
  console.warn(JSON.stringify({ level: "warn", message, ...fields, ts: new Date().toISOString() }));
}
