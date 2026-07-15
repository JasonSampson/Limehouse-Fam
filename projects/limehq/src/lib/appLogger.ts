// Minimal structured logger, same shape as the other two projects'
// appLogger — plain JSON lines to stdout, no external logging service.
export function logInfo(message: string, meta: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", message, ...meta, ts: new Date().toISOString() }));
}

export function logWarn(message: string, meta: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: "warn", message, ...meta, ts: new Date().toISOString() }));
}

export function logError(message: string, meta: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "error", message, ...meta, ts: new Date().toISOString() }));
}
