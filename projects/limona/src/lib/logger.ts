// Minimal structured logger — matches limehouse-dashboard's src/lib/logger.ts
// convention of plain console output with a consistent shape, no external
// logging service (not needed at this scale).
export function logInfo(message: string, meta?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: "info", message, ...meta, ts: new Date().toISOString() }));
}

export function logError(message: string, meta?: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "error", message, ...meta, ts: new Date().toISOString() }));
}
