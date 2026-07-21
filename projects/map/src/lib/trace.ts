import { randomUUID } from "node:crypto";

export interface Trace {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
}

// Starts a new trace (e.g. one daily sync run).
export function startTrace(): Trace {
  return { trace_id: randomUUID(), span_id: randomUUID(), parent_span_id: null };
}

// Derives a child span within the same trace (e.g. one sync step's own
// span within the overall daily run's trace).
export function childSpan(parent: Trace): Trace {
  return { trace_id: parent.trace_id, span_id: randomUUID(), parent_span_id: parent.span_id };
}
