import type { VideoGrant } from "livekit-server-sdk";
import {
  TrackSource,
  type ParticipantPermissionPatch,
  type TokenMinter,
} from "../clients/livekit.ts";
import type { Logger } from "../logger.ts";
import { traceLogFields, type TraceContext } from "../lib/trace.ts";
import type { Metrics } from "../metrics.ts";
import type { UserId } from "../models/ids.ts";
import type { TokenResponse } from "../models/token.ts";

/**
 * Maps internal access grants onto a LiveKit video grant.
 *
 * - `can_connect` → `roomJoin` (enforced by the caller before minting).
 * - `can_speak`   → microphone publishing / data publishing.
 * - `can_video`   → camera + screen share publishing.
 * - `canSubscribe` is always granted for connected participants.
 *
 * A listen-only participant (timed out) receives `canPublish: false`, no publish
 * sources and no data-publishing permission.
 */
export function mapVideoGrant(
  room: string,
  canSpeak: boolean,
  canVideo: boolean,
): VideoGrant {
  const canPublish = canSpeak || canVideo;
  const sources: TrackSource[] = [];

  if (canSpeak) {
    sources.push(TrackSource.MICROPHONE);
  }

  if (canVideo) {
    sources.push(
      TrackSource.CAMERA,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO,
    );
  }

  return {
    room,
    roomJoin: true,
    canSubscribe: true,
    canPublish,
    canPublishSources: canPublish ? sources : [],
    canPublishData: canSpeak,
  };
}

/**
 * Maps access grants onto the permission patch used to (re)apply capabilities on
 * an already-connected LiveKit participant.
 */
export function mapPermissionPatch(
  canSpeak: boolean,
  canVideo: boolean,
): ParticipantPermissionPatch {
  const grant = mapVideoGrant("", canSpeak, canVideo);

  return {
    canPublish: grant.canPublish ?? false,
    canPublishSources: grant.canPublishSources ?? [],
    canPublishData: grant.canPublishData ?? false,
    canSubscribe: true,
  };
}

export interface IssueTokenInput {
  readonly room: string;
  readonly userId: UserId;
  readonly displayName?: string;
  readonly canSpeak: boolean;
  readonly canVideo: boolean;
  readonly trace: TraceContext;
}

export interface TokenServiceOptions {
  readonly minter: TokenMinter;
  readonly serverUrl: string;
  readonly ttlSeconds: number;
  readonly metrics: Pick<Metrics, "tokensIssued">;
  readonly logger: Logger;
}

/**
 * Mints short-lived LiveKit access tokens locally (no network call) and records
 * the issuance metric.
 */
export class TokenService {
  constructor(private readonly options: TokenServiceOptions) {}

  async issue(input: IssueTokenInput): Promise<TokenResponse> {
    const grant = mapVideoGrant(input.room, input.canSpeak, input.canVideo);
    const minted = await this.options.minter.mint({
      room: input.room,
      identity: input.userId,
      ...(input.displayName ? { name: input.displayName } : {}),
      ttlSeconds: this.options.ttlSeconds,
      grant,
    });

    this.options.metrics.tokensIssued.inc({
      grant: input.canSpeak || input.canVideo ? "full" : "listen_only",
    });

    this.options.logger.info("livekit token issued", {
      ...traceLogFields(input.trace),
      room: input.room,
      ttl_seconds: this.options.ttlSeconds,
      can_speak: input.canSpeak,
      can_video: input.canVideo,
    });

    return {
      server_url: this.options.serverUrl,
      token: minted.token,
      room: input.room,
      expires_at: minted.expiresAt.toISOString(),
      grants: {
        can_speak: input.canSpeak,
        can_video: input.canVideo,
      },
    };
  }
}
