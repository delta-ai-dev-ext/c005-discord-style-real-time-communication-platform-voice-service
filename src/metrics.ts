import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";

export interface Metrics {
  readonly registry: Registry;
  readonly tokensIssued: Counter<"grant">;
  readonly participantsJoined: Counter;
  readonly sessionsMinutes: Counter;
  readonly roomFullRejections: Counter;
  readonly moderationEvictions: Counter<"action">;
  readonly httpRequestDuration: Histogram<"route" | "method" | "status_class">;
  readonly livekitApiDuration: Histogram<"operation">;
  readonly livekitApiErrors: Counter<"operation">;
  readonly kafkaConsumerLag: Gauge<"topic" | "group">;
}

export type ModerationAction =
  | "kick"
  | "ban"
  | "timeout"
  | "channel_deleted"
  | "permission_revoked";

/**
 * Registers every `voice_*` / `http_*` metric at startup as required by the
 * observability conventions. Labels are strictly low-cardinality: never
 * `user_id`, `community_id` or `channel_id`.
 */
export function createMetrics(registry: Registry = new Registry()): Metrics {
  collectDefaultMetrics({ register: registry });

  const tokensIssued = new Counter({
    name: "voice_tokens_issued_total",
    help: "LiveKit access tokens issued, by grant level",
    labelNames: ["grant"] as const,
    registers: [registry],
  });

  const participantsJoined = new Counter({
    name: "voice_participants_joined_total",
    help: "Participant join events received from LiveKit webhooks",
    registers: [registry],
  });

  const sessionsMinutes = new Counter({
    name: "voice_sessions_minutes_total",
    help: "Accumulated voice participation minutes derived from LiveKit webhooks",
    registers: [registry],
  });

  const roomFullRejections = new Counter({
    name: "voice_room_full_rejections_total",
    help: "Token requests rejected because the room was at capacity",
    registers: [registry],
  });

  const moderationEvictions = new Counter({
    name: "voice_moderation_evictions_total",
    help: "Moderation actions applied to LiveKit participants",
    labelNames: ["action"] as const,
    registers: [registry],
  });

  const httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["route", "method", "status_class"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const livekitApiDuration = new Histogram({
    name: "voice_livekit_api_duration_seconds",
    help: "Duration of outbound LiveKit server API calls",
    labelNames: ["operation"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2],
    registers: [registry],
  });

  const livekitApiErrors = new Counter({
    name: "voice_livekit_api_errors_total",
    help: "Failed outbound LiveKit server API calls",
    labelNames: ["operation"] as const,
    registers: [registry],
  });

  const kafkaConsumerLag = new Gauge({
    name: "kafka_consumer_lag",
    help: "Approximate consumer lag per topic/partition set",
    labelNames: ["topic", "group"] as const,
    registers: [registry],
  });

  return {
    registry,
    tokensIssued,
    participantsJoined,
    sessionsMinutes,
    roomFullRejections,
    moderationEvictions,
    httpRequestDuration,
    livekitApiDuration,
    livekitApiErrors,
    kafkaConsumerLag,
  };
}
