import { startTrace, type TraceContext } from "./trace.ts";

export interface RequestContext {
  readonly trace: TraceContext;
  /** `performance.now()` timestamp used for the request duration histogram. */
  readonly startedAt: number;
}

const contexts = new WeakMap<Request, RequestContext>();

/**
 * Creates (once per request) the trace context and start timestamp used for
 * logging, downstream propagation and HTTP metrics.
 */
export function attachRequestContext(request: Request): RequestContext {
  const existing = contexts.get(request);

  if (existing) {
    return existing;
  }

  const context: RequestContext = {
    trace: startTrace(request.headers.get("traceparent")),
    startedAt: performance.now(),
  };

  contexts.set(request, context);

  return context;
}

export function requestContext(request: Request): RequestContext {
  return contexts.get(request) ?? attachRequestContext(request);
}
