/**
 * W3C Trace Context propagation helpers.
 *
 * The service does not vendor a full tracer: it propagates `traceparent` across
 * outbound HTTP calls and Kafka headers and emits the trace/span identifiers on
 * every structured log line, as required by the observability conventions.
 */

export interface TraceContext {
  /** 32 hex characters. */
  readonly traceId: string;
  /** 16 hex characters of the span created by this service. */
  readonly spanId: string;
  /** 16 hex characters of the upstream span, when the request was traced. */
  readonly parentSpanId?: string;
  /** Value to send downstream in the `traceparent` header. */
  readonly traceparent: string;
}

const TRACEPARENT_PATTERN =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const INVALID_TRACE_ID = "00000000000000000000000000000000";
const INVALID_PARENT_ID = "0000000000000000";

export const TRACEPARENT_HEADER = "traceparent";

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export interface ParsedTraceparent {
  readonly traceId: string;
  readonly parentSpanId: string;
  readonly flags: string;
}

export function parseTraceparent(
  header: string | null | undefined,
): ParsedTraceparent | null {
  if (!header) {
    return null;
  }

  const match = TRACEPARENT_PATTERN.exec(header.trim().toLowerCase());

  if (!match) {
    return null;
  }

  const [, version, traceId, parentSpanId, flags] = match;

  if (!version || !traceId || !parentSpanId || !flags) {
    return null;
  }

  if (traceId === INVALID_TRACE_ID || parentSpanId === INVALID_PARENT_ID) {
    return null;
  }

  return { traceId, parentSpanId, flags };
}

/**
 * Derives a trace context for an inbound request/event. An inbound `traceparent`
 * is continued (new span, same trace); otherwise a fresh trace is started.
 */
export function startTrace(header?: string | null): TraceContext {
  const spanId = randomHex(8);
  const parsed = parseTraceparent(header);

  if (!parsed) {
    const traceId = randomHex(16);

    return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
  }

  return {
    traceId: parsed.traceId,
    spanId,
    parentSpanId: parsed.parentSpanId,
    traceparent: `00-${parsed.traceId}-${spanId}-${parsed.flags}`,
  };
}

/** Log fields every structured log line should carry. */
export function traceLogFields(trace: TraceContext): Record<string, string> {
  return {
    trace_id: trace.traceId,
    span_id: trace.spanId,
  };
}
