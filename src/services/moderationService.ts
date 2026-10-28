import type { Logger } from "../logger.ts";
import { channelIdFromRoomName, roomNameForChannel } from "../lib/room.ts";
import { traceLogFields, type TraceContext } from "../lib/trace.ts";
import type { Metrics, ModerationAction } from "../metrics.ts";
import type { CommunityEvent } from "../models/events.ts";
import { decideJoinAccess, type AuthorizationService } from "./authorizationService.ts";
import { mapPermissionPatch } from "./tokenService.ts";
import type { RoomService } from "./roomService.ts";

export interface ModerationServiceOptions {
  readonly authorization: AuthorizationService;
  readonly rooms: RoomService;
  readonly metrics: Pick<Metrics, "moderationEvictions">;
  readonly logger: Logger;
}

/**
 * Applies `community_events` moderation actions to LiveKit rooms.
 *
 * Every handler is written to be idempotent: removing an absent participant or
 * updating a participant that already left is a no-op, so duplicate deliveries
 * (or the consumer's at-least-once retries) converge to the same state.
 */
export class ModerationService {
  constructor(private readonly options: ModerationServiceOptions) {}

  async apply(event: CommunityEvent, trace: TraceContext): Promise<void> {
    switch (event.event_type) {
      case "member_kicked":
        await this.removeMember(
          event.payload.user_id,
          event.payload.voice_channel_ids,
          "kick",
          trace,
        );
        return;

      case "member_banned":
        await this.removeMember(
          event.payload.user_id,
          event.payload.voice_channel_ids,
          "ban",
          trace,
        );
        return;

      case "member_timed_out":
        await this.revokePublish(
          event.payload.user_id,
          event.payload.voice_channel_ids,
          trace,
        );
        return;

      case "timeout_cleared":
        await this.reevaluateMember(
          event.payload.user_id,
          event.payload.voice_channel_ids,
          trace,
        );
        return;

      case "channel_deleted":
        await this.closeChannel(event.payload.channel_id, trace);
        return;

      case "permission_overwrites_changed":
        await this.reevaluateChannel(
          event.payload.channel_id,
          event.payload.affected_user_ids,
          trace,
        );
        return;

      case "member_roles_changed":
        await this.reevaluateMember(
          event.payload.user_id,
          event.payload.voice_channel_ids,
          trace,
        );
        return;
    }
  }

  private async removeMember(
    userId: string,
    channelIds: readonly string[],
    action: Extract<ModerationAction, "kick" | "ban">,
    trace: TraceContext,
  ): Promise<void> {
    const rooms = await this.options.rooms.targetRooms(channelIds);
    let removed = 0;

    for (const room of rooms) {
      if (await this.options.rooms.removeParticipant(room, userId)) {
        removed += 1;
      }
    }

    this.options.metrics.moderationEvictions.inc({ action });
    this.options.logger.info("moderation eviction applied", {
      ...traceLogFields(trace),
      event_type: `member_${action === "kick" ? "kicked" : "banned"}`,
      user_id: userId,
      rooms_checked: rooms.length,
      rooms_evicted: removed,
    });
  }

  private async revokePublish(
    userId: string,
    channelIds: readonly string[],
    trace: TraceContext,
  ): Promise<void> {
    const rooms = await this.options.rooms.targetRooms(channelIds);
    const listenOnly = mapPermissionPatch(false, false);

    for (const room of rooms) {
      await this.options.rooms.applyPermissions(room, userId, listenOnly);
    }

    this.options.metrics.moderationEvictions.inc({ action: "timeout" });
    this.options.logger.info("publish permissions revoked", {
      ...traceLogFields(trace),
      event_type: "member_timed_out",
      user_id: userId,
      rooms_checked: rooms.length,
    });
  }

  /**
   * Re-evaluates the member's access and either restores publish permissions or
   * removes them from the room when access was revoked.
   */
  private async reevaluateMember(
    userId: string,
    channelIds: readonly string[],
    trace: TraceContext,
  ): Promise<void> {
    const rooms = await this.options.rooms.targetRooms(channelIds);

    for (const room of rooms) {
      await this.applyAccessDecision(room, userId, trace);
    }
  }

  private async reevaluateChannel(
    channelId: string,
    affectedUserIds: readonly string[],
    trace: TraceContext,
  ): Promise<void> {
    const room = roomNameForChannel(channelId);
    const participants = await this.options.rooms.listRoomParticipants(room);
    const targets =
      affectedUserIds.length > 0
        ? affectedUserIds
        : participants.map((participant) => participant.identity);

    for (const userId of targets) {
      await this.applyAccessDecision(room, userId, trace);
    }
  }

  private async applyAccessDecision(
    room: string,
    userId: string,
    trace: TraceContext,
  ): Promise<void> {
    const channelId = channelIdFromRoomName(room);

    if (!channelId) {
      this.options.logger.debug("skipping non-voice room", { room });

      return;
    }

    const access = await this.options.authorization.getChannelAccess(
      channelId,
      userId,
      trace,
    );
    const decision = decideJoinAccess(access);

    if (decision.kind === "deny") {
      const removed = await this.options.rooms.removeParticipant(room, userId);

      this.options.metrics.moderationEvictions.inc({ action: "permission_revoked" });
      this.options.logger.info("participant removed after access re-check", {
        ...traceLogFields(trace),
        room,
        user_id: userId,
        reason: decision.code,
        removed,
      });

      return;
    }

    const patch = mapPermissionPatch(decision.canSpeak, decision.canVideo);

    await this.options.rooms.applyPermissions(room, userId, patch);
    this.options.logger.info("participant permissions re-applied", {
      ...traceLogFields(trace),
      room,
      user_id: userId,
      can_speak: decision.canSpeak,
      can_video: decision.canVideo,
    });
  }

  private async closeChannel(
    channelId: string,
    trace: TraceContext,
  ): Promise<void> {
    const room = roomNameForChannel(channelId);
    const deleted = await this.options.rooms.deleteRoom(room);

    this.options.metrics.moderationEvictions.inc({ action: "channel_deleted" });
    this.options.logger.info("voice room closed after channel deletion", {
      ...traceLogFields(trace),
      room,
      deleted,
    });
  }
}
