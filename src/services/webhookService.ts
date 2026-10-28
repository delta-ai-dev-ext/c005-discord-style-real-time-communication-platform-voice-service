import type { LiveKitWebhookEvent, WebhookVerifier } from "../clients/webhookVerifier.ts";
import type { Logger } from "../logger.ts";
import { traceLogFields, type TraceContext } from "../lib/trace.ts";
import type { Metrics } from "../metrics.ts";

export interface WebhookServiceOptions {
  readonly verifier: WebhookVerifier;
  readonly metrics: Pick<Metrics, "participantsJoined" | "sessionsMinutes">;
  readonly logger: Logger;
  readonly clock?: () => number;
}

/** Minutes elapsed since a timestamp, clamped at zero for clock skew. */
export function elapsedMinutes(
  startedAtMs: number | undefined,
  now: number,
): number {
  if (startedAtMs === undefined || !Number.isFinite(startedAtMs)) {
    return 0;
  }

  const minutes = (now - startedAtMs) / 60_000;

  return minutes > 0 ? minutes : 0;
}

/**
 * Handles signed LiveKit webhooks and turns them into session telemetry.
 * Verification errors surface as `401` via the HTTP layer.
 */
export class WebhookService {
  private readonly clock: () => number;

  constructor(private readonly options: WebhookServiceOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  async handle(
    body: string,
    authHeader: string | null | undefined,
    trace: TraceContext,
  ): Promise<LiveKitWebhookEvent> {
    const event = await this.options.verifier.verify(body, authHeader);

    switch (event.event) {
      case "participant_joined":
        this.options.metrics.participantsJoined.inc();
        break;

      case "participant_left":
        this.options.metrics.sessionsMinutes.inc(
          elapsedMinutes(event.participantJoinedAtMs, this.clock()),
        );
        break;

      case "room_finished":
        this.options.metrics.sessionsMinutes.inc(
          elapsedMinutes(event.roomCreatedAtMs, this.clock()),
        );
        break;

      default:
        this.options.logger.debug("ignoring livekit webhook event", {
          event_type: event.event,
        });
    }

    this.options.logger.info("livekit webhook processed", {
      ...traceLogFields(trace),
      event_type: event.event,
      ...(event.roomName ? { room: event.roomName } : {}),
    });

    return event;
  }
}
