import { extractBearerToken, type TokenAuthenticator } from "../clients/clerk.ts";
import type { Logger } from "../logger.ts";
import { roomNameForChannel } from "../lib/room.ts";
import type { TraceContext } from "../lib/trace.ts";
import {
  banned as bannedError,
  invalidRequest,
  missingPermission,
} from "../models/errors.ts";
import { channelIdSchema, type ChannelId } from "../models/ids.ts";
import type { Participant } from "../models/participants.ts";
import type { TokenResponse } from "../models/token.ts";
import {
  decideJoinAccess,
  decideViewAccess,
  type AuthorizationService,
} from "../services/authorizationService.ts";
import type { RoomService } from "../services/roomService.ts";
import type { TokenService } from "../services/tokenService.ts";

export interface VoiceControllerOptions {
  readonly authenticator: TokenAuthenticator;
  readonly authorization: AuthorizationService;
  readonly rooms: RoomService;
  readonly tokens: TokenService;
  readonly logger: Logger;
}

export interface AuthenticatedRequestInput {
  readonly channelId: string;
  readonly authorizationHeader: string | null | undefined;
  readonly trace: TraceContext;
}

/** Parses and validates the `channel_id` path parameter. */
export function parseChannelId(value: string | undefined): ChannelId {
  const parsed = channelIdSchema.safeParse(value ?? "");

  if (!parsed.success) {
    throw invalidRequest("Invalid channel_id", {
      issues: parsed.error.issues.map((issue) => issue.message),
    });
  }

  return parsed.data;
}

/**
 * Thin request handlers for the voice endpoints. All business rules live in the
 * authorization, room and token services.
 */
export class VoiceController {
  constructor(private readonly options: VoiceControllerOptions) {}

  async issueToken(input: AuthenticatedRequestInput): Promise<TokenResponse> {
    const channelId = parseChannelId(input.channelId);
    const user = await this.options.authenticator.authenticate(
      extractBearerToken(input.authorizationHeader),
    );

    const access = await this.options.authorization.getChannelAccess(
      channelId,
      user.userId,
      input.trace,
    );
    const decision = decideJoinAccess(access);

    if (decision.kind === "deny") {
      this.options.logger.info("token request denied", {
        trace_id: input.trace.traceId,
        span_id: input.trace.spanId,
        channel_id: channelId,
        reason: decision.code,
      });

      throw decision.code === "banned" ? bannedError() : missingPermission();
    }

    const room = roomNameForChannel(channelId);

    await this.options.rooms.assertCapacity(room);

    return this.options.tokens.issue({
      room,
      userId: user.userId,
      ...(user.username ? { displayName: user.username } : {}),
      canSpeak: decision.canSpeak,
      canVideo: decision.canVideo,
      trace: input.trace,
    });
  }

  async listParticipants(input: AuthenticatedRequestInput): Promise<Participant[]> {
    const channelId = parseChannelId(input.channelId);
    const user = await this.options.authenticator.authenticate(
      extractBearerToken(input.authorizationHeader),
    );

    const access = await this.options.authorization.getChannelAccess(
      channelId,
      user.userId,
      input.trace,
    );
    const decision = decideViewAccess(access);

    if (decision.kind === "deny") {
      throw decision.code === "banned" ? bannedError() : missingPermission();
    }

    return this.options.rooms.listParticipants(channelId);
  }
}
