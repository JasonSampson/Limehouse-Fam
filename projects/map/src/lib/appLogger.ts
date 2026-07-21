// Application logger. Same hard rule as late-rent-notices (Sentinel +
// CLAUDE.md): application logs must NEVER contain full tenant PII (names,
// phone numbers, addresses, rent amounts). Log identifiers/counts only.
//
// Thin wrapper, not a logging framework — keeps the "what's allowed in
// here" surface small and obvious at a glance.
export interface LogFields {
  traceId?: string;
  spanId?: string;
  jobName?: string;
  propertyId?: number;
  unitId?: number;
  leaseId?: number;
  [key: string]: unknown;
}

// Fields explicitly declared above are reviewed-safe by construction
// (identifiers/counts only, no PII) — the substring check below only
// polices OTHER, ad-hoc keys callers pass through the index signature.
const ALLOWED_KEYS = new Set(["traceId", "spanId", "jobName", "propertyId", "unitId", "leaseId"]);

function assertNoPii(fields: LogFields): void {
  const forbiddenKeys = ["name", "email", "phone", "amount", "rent", "address", "tenant", "fullName", "fullname"];
  for (const key of Object.keys(fields)) {
    if (ALLOWED_KEYS.has(key)) continue;
    const lower = key.toLowerCase();
    if (forbiddenKeys.some((f) => lower.includes(f))) {
      throw new Error(
        `appLogger: refusing to log field "${key}" — looks like tenant/property PII. Don't log it.`
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
