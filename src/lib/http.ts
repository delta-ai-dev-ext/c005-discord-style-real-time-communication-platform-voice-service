export interface FetchWithRetryOptions {
  /** Per-attempt timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Number of additional attempts after the first one. */
  readonly retries: number;
}

export class UpstreamTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UpstreamTimeoutError";
  }
}

/**
 * `fetch` with a hard per-attempt timeout and bounded retries. Retries cover
 * transport failures, timeouts and 5xx responses; 4xx responses are returned to
 * the caller immediately because they carry a decision, not a transient fault.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchWithRetryOptions,
): Promise<Response> {
  const attempts = Math.max(1, options.retries + 1);
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
      });

      if (response.status >= 500 && attempt < attempts - 1) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;

      if (attempt === attempts - 1) {
        break;
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);

  throw new UpstreamTimeoutError(
    `Request to ${url} failed after ${attempts} attempt(s): ${detail}`,
    { cause: lastError },
  );
}
