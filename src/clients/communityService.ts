import type { Logger } from "../logger.ts";
import { fetchWithRetry } from "../lib/http.ts";
import { traceLogFields, type TraceContext } from "../lib/trace.ts";
import { channelAccessSchema, deniedAccess, type ChannelAccess } from "../models/access.ts";
import { upstreamUnavailable } from "../models/errors.ts";

export interface ChannelAccessLookup {
  readonly channelId: string;
  readonly userId: string;
  readonly trace: TraceContext;
}

/**
 * Internal access-control API owned by `community_service`. Kept as an interface
 * so HTTP tests can inject a stub.
 */
export interface ChannelAccessClient {
  getChannelAccess(lookup: ChannelAccessLookup): Promise<ChannelAccess>;
}

export interface CommunityServiceOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
  readonly retries: number;
}

const ACCESS_PATH = "/internal/v1/channels";

/**
 * Synchronous REST client for `community_service`. Short timeout with a single
 * retry, and **fail closed**: any transport fault, timeout, 5xx or malformed
 * payload denies access with `503 upstream_unavailable`.
 */
export class HttpCommunityServiceClient implements ChannelAccessClient {
  constructor(
    private readonly options: CommunityServiceOptions,
    private readonly logger: Logger,
  ) {}

  async getChannelAccess({
    channelId,
    userId,
    trace,
  }: ChannelAccessLookup): Promise<ChannelAccess> {
    const url = `${this.options.baseUrl}${ACCESS_PATH}/${encodeURIComponent(channelId)}/access/${encodeURIComponent(userId)}`;

    let response: Response;

    try {
      response = await fetchWithRetry(
        url,
        {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${this.options.token}`,
            traceparent: trace.traceparent,
          },
        },
        { timeoutMs: this.options.timeoutMs, retries: this.options.retries },
      );
    } catch (error) {
      this.logger.error("community_service access lookup failed", {
        ...traceLogFields(trace),
        channel_id: channelId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw upstreamUnavailable("Access control service is unavailable", error);
    }

    if (response.status === 200) {
      const payload = await readJson(response);
      const parsed = channelAccessSchema.safeParse(payload);

      if (!parsed.success) {
        this.logger.error("community_service returned an invalid access payload", {
          ...traceLogFields(trace),
          channel_id: channelId,
          issues: parsed.error.issues.map((issue) => issue.path.join(".")),
        });

        throw upstreamUnavailable(
          "Access control service returned an invalid response",
        );
      }

      return parsed.data;
    }

    if (response.status === 403) {
      const payload = await readJson(response);
      const code = extractErrorCode(payload);

      return deniedAccess(userId, channelId, code === "banned" ? "banned" : "not_member");
    }

    if (response.status === 404) {
      return deniedAccess(userId, channelId, "not_member");
    }

    this.logger.error("community_service access lookup returned an error", {
      ...traceLogFields(trace),
      channel_id: channelId,
      status_code: response.status,
    });

    throw upstreamUnavailable(
      `Access control service responded with status ${response.status}`,
    );
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function extractErrorCode(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }

  const error = (payload as { error?: unknown }).error;

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;

    return typeof code === "string" ? code : undefined;
  }

  return undefined;
}
