// Minimal structured logger. This dashboard is read-only against tenant
// data (no notices sent, no PII written anywhere) so the strict PII
// scrubbing late-rent-notices' appLogger.ts enforces is not required here —
// but callers should still avoid logging full balances/names as a matter of
// habit, not because this module blocks it.
export interface LogFields {
  [key: string]: unknown;
}

export function logInfo(message: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ level: "info", message, ...fields, ts: new Date().toISOString() }));
}

export function logWarn(message: string, fields: LogFields = {}): void {
  console.warn(JSON.stringify({ level: "warn", message, ...fields, ts: new Date().toISOString() }));
}

export function logError(message: string, fields: LogFields = {}): void {
  console.error(JSON.stringify({ level: "error", message, ...fields, ts: new Date().toISOString() }));
}
