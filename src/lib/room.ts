import type { ChannelId } from "../models/ids.ts";

const ROOM_PREFIX = "voice_";

/**
 * LiveKit room names are derived deterministically from the channel id so that
 * every stateless pod (and every client) computes the same room without shared
 * storage. The prefix keeps voice rooms distinguishable from other LiveKit
 * room types in the same project.
 */
export function roomNameForChannel(channelId: string): string {
  return `${ROOM_PREFIX}${channelId}`;
}

/** Inverse of {@link roomNameForChannel}; `null` when the room is not a voice room. */
export function channelIdFromRoomName(room: string): ChannelId | null {
  if (!room.startsWith(ROOM_PREFIX)) {
    return null;
  }

  const channelId = room.slice(ROOM_PREFIX.length);

  return channelId.length > 0 ? (channelId as ChannelId) : null;
}
