import { WebhookReceiver } from "livekit-server-sdk";
import type { Logger } from "../logger.ts";
import { unauthorized } from "../models/errors.ts";

/**
 * Transport-neutral view of a LiveKit webhook, extracted from the protobuf
 * `WebhookEvent` so the rest of the service does not depend on protobuf types.
 */
export interface LiveKitWebhookEvent {
  readonly event: string;
  readonly roomName?: string;
  readonly roomCreatedAtMs?: number;
  readonly participantIdentity?: string;
  readonly participantJoinedAtMs?: number;
}

export interface WebhookVerifier {
  /**
   * Verifies the `Authorize` JWT (which embeds the SHA-256 hash of the body) and
   * returns the decoded event.
   */
  verify(
    body: string,
    authHeader: string | null | undefined,
  ): Promise<LiveKitWebhookEvent>;
}

interface RawRoom {
  readonly name?: unknown;
  /** `Room.creation_time` (seconds) / `Room.creation_time_ms`. */
  readonly creationTime?: unknown;
  readonly creationTimeMs?: unknown;
  readonly createdAt?: unknown;
  readonly createdAtMs?: unknown;
}

interface RawParticipant {
  readonly identity?: unknown;
  readonly joinedAt?: unknown;
  readonly joinedAtMs?: unknown;
}

interface RawWebhookEvent {
  readonly event?: unknown;
  readonly room?: RawRoom | null;
  readonly participant?: RawParticipant | null;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "bigint" || typeof value === "number") {
    const numeric = Number(value);

    return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
  }

  if (typeof value === "string" && value.length > 0) {
    const numeric = Number(value);

    return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
  }

  return undefined;
}

function toMilliseconds(
  secondsValue: unknown,
  msValue: unknown,
): number | undefined {
  const ms = toNumber(msValue);

  if (ms !== undefined) {
    return ms;
  }

  const seconds = toNumber(secondsValue);

  return seconds === undefined ? undefined : seconds * 1000;
}

/** Converts the SDK event into the domain view used by the webhook service. */
export function toWebhookEvent(raw: RawWebhookEvent): LiveKitWebhookEvent {
  const roomName = typeof raw.room?.name === "string" ? raw.room.name : undefined;
  const participantIdentity =
    typeof raw.participant?.identity === "string"
      ? raw.participant.identity
      : undefined;
  const roomCreatedAtMs = toMilliseconds(
    raw.room?.creationTime ?? raw.room?.createdAt,
    raw.room?.creationTimeMs ?? raw.room?.createdAtMs,
  );
  const participantJoinedAtMs = toMilliseconds(
    raw.participant?.joinedAt,
    raw.participant?.joinedAtMs,
  );

  return {
    event: typeof raw.event === "string" ? raw.event : "",
    ...(roomName === undefined ? {} : { roomName }),
    ...(roomCreatedAtMs === undefined ? {} : { roomCreatedAtMs }),
    ...(participantIdentity === undefined ? {} : { participantIdentity }),
    ...(participantJoinedAtMs === undefined ? {} : { participantJoinedAtMs }),
  };
}

/**
 * Verifies LiveKit webhooks with the official `WebhookReceiver` (JWT signature
 * plus body SHA-256). Any verification failure becomes a `401`.
 */
export class LiveKitWebhookVerifier implements WebhookVerifier {
  private readonly receiver: WebhookReceiver;

  constructor(
    apiKey: string,
    apiSecret: string,
    private readonly logger: Logger,
  ) {
    this.receiver = new WebhookReceiver(apiKey, apiSecret);
  }

  async verify(
    body: string,
    authHeader: string | null | undefined,
  ): Promise<LiveKitWebhookEvent> {
    if (!authHeader) {
      throw unauthorized("Missing LiveKit webhook authorization header");
    }

    try {
      const event = await this.receiver.receive(body, authHeader);

      return toWebhookEvent(event as unknown as RawWebhookEvent);
    } catch (error) {
      this.logger.warn("livekit webhook verification failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      throw unauthorized("Invalid LiveKit webhook signature");
    }
  }
}
