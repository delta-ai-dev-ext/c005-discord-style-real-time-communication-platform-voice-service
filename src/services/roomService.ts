import {
  isRoomNotFoundError,
  TrackSource,
  type LiveKitRoomClient,
  type ParticipantPermissionPatch,
  type RoomParticipant,
} from "../clients/livekit.ts";
import type { Logger } from "../logger.ts";
import { roomNameForChannel } from "../lib/room.ts";
import type { Metrics } from "../metrics.ts";
import { internalError, roomFull } from "../models/errors.ts";
import type { ChannelId } from "../models/ids.ts";
import type { Participant } from "../models/participants.ts";

/**
 * Maps a LiveKit participant onto the public participant shape.
 *
 * `is_muted` is true when no microphone track is published or the microphone
 * track is muted; `has_video` is true when a camera or screen-share track is
 * published.
 */
export function toParticipantSummary(participant: RoomParticipant): Participant {
  const microphone = participant.tracks.find(
    (track) => track.source === TrackSource.MICROPHONE,
  );

  const isMuted = !microphone || microphone.muted;

  const hasVideo = participant.tracks.some(
    (track) =>
      track.source === TrackSource.CAMERA ||
      track.source === TrackSource.SCREEN_SHARE,
  );

  return {
    user_id: participant.identity,
    is_muted: isMuted,
    has_video: hasVideo,
    joined_at: new Date(participant.joinedAtMs).toISOString(),
  };
}

export interface RoomServiceOptions {
  readonly client: LiveKitRoomClient;
  readonly maxRoomCapacity: number;
  readonly metrics: Pick<Metrics, "roomFullRejections">;
  readonly logger: Logger;
}

/**
 * Room-level operations against LiveKit. All room state is owned by LiveKit and
 * queried on demand — this service keeps nothing locally (ADR-001).
 */
export class RoomService {
  constructor(private readonly options: RoomServiceOptions) {}

  /** Participants of a room; a missing room is an empty room (US-002). */
  async listRoomParticipants(room: string): Promise<RoomParticipant[]> {
    try {
      return await this.options.client.listParticipants(room);
    } catch (error) {
      if (isRoomNotFoundError(error)) {
        return [];
      }

      throw internalError("Failed to list LiveKit participants", error);
    }
  }

  async listParticipants(channelId: ChannelId): Promise<Participant[]> {
    const participants = await this.listRoomParticipants(
      roomNameForChannel(channelId),
    );

    return participants.map(toParticipantSummary);
  }

  /** Enforces the backend room cap before a token is minted. */
  async assertCapacity(room: string): Promise<void> {
    const participants = await this.listRoomParticipants(room);

    if (participants.length >= this.options.maxRoomCapacity) {
      this.options.metrics.roomFullRejections.inc();

      throw roomFull(this.options.maxRoomCapacity);
    }
  }

  /** Removes a participant; a missing room/participant is a no-op. */
  async removeParticipant(room: string, userId: string): Promise<boolean> {
    try {
      await this.options.client.removeParticipant(room, userId);

      return true;
    } catch (error) {
      if (isRoomNotFoundError(error)) {
        this.options.logger.debug("participant not present in room", {
          room,
          user_id: userId,
        });

        return false;
      }

      throw error;
    }
  }

  /** Applies publish permissions to a connected participant. */
  async applyPermissions(
    room: string,
    userId: string,
    patch: ParticipantPermissionPatch,
  ): Promise<boolean> {
    try {
      await this.options.client.updateParticipantPermissions(room, userId, patch);

      return true;
    } catch (error) {
      if (isRoomNotFoundError(error)) {
        this.options.logger.debug("participant not present in room", {
          room,
          user_id: userId,
        });

        return false;
      }

      throw error;
    }
  }

  /** Closes a room (used when the channel itself is deleted). */
  async deleteRoom(room: string): Promise<boolean> {
    try {
      await this.options.client.deleteRoom(room);

      return true;
    } catch (error) {
      if (isRoomNotFoundError(error)) {
        return false;
      }

      throw error;
    }
  }

  async listActiveRoomNames(): Promise<string[]> {
    try {
      return await this.options.client.listRoomNames();
    } catch (error) {
      throw internalError("Failed to list LiveKit rooms", error);
    }
  }

  /**
   * Rooms a moderation action must target. Events normally carry
   * `voice_channel_ids`; when they do not, every active room is a candidate and
   * per-room not-found responses are ignored by the callers.
   */
  async targetRooms(channelIds: readonly string[]): Promise<string[]> {
    if (channelIds.length > 0) {
      return channelIds.map((channelId) => roomNameForChannel(channelId));
    }

    return this.listActiveRoomNames();
  }
}
