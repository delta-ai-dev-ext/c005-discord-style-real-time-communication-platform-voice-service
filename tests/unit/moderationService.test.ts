import { describe, expect, it } from "bun:test";
import { TrackSource } from "../../src/clients/livekit.ts";
import { startTrace } from "../../src/lib/trace.ts";
import type { ChannelAccess } from "../../src/models/access.ts";
import type { CommunityEvent } from "../../src/models/events.ts";
import { AuthorizationService } from "../../src/services/authorizationService.ts";
import { ModerationService } from "../../src/services/moderationService.ts";
import { RoomService } from "../../src/services/roomService.ts";
import {
  createFakeRoomClient,
  createTestAccessClient,
  createTestLogger,
  createTestMetrics,
  fullAccess,
  makeParticipant,
} from "../mocks/index.ts";

const trace = startTrace(null);

const ROOM_1 = "voice_channel-1";
const ROOM_2 = "voice_channel-2";

type AccessOverride =
  | Partial<ChannelAccess>
  | ((channelId: string, userId: string) => ChannelAccess);

function createHarness(
  access: AccessOverride = {},
  roomClient = createFakeRoomClient({
    rooms: [ROOM_1, ROOM_2],
    participants: {
      [ROOM_1]: [makeParticipant({ identity: "user-1" })],
      [ROOM_2]: [makeParticipant({ identity: "user-1" })],
    },
  }),
) {
  const metrics = createTestMetrics();
  const logger = createTestLogger();
  const accessClient = createTestAccessClient(access);
  const rooms = new RoomService({
    client: roomClient.client,
    maxRoomCapacity: 50,
    metrics,
    logger,
  });
  const authorization = new AuthorizationService(accessClient);
  const moderation = new ModerationService({
    authorization,
    rooms,
    metrics,
    logger,
  });

  return { moderation, roomClient, metrics, logger, accessClient };
}

async function evictionCount(metrics: ReturnType<typeof createTestMetrics>) {
  const metric = await metrics.moderationEvictions.get();

  return Object.fromEntries(
    metric.values.map((value) => [value.labels.action, value.value]),
  );
}

describe("ModerationService", () => {
  it("removes kicked members from every room listed in the event", async () => {
    const { moderation, roomClient, metrics } = createHarness();
    const event: CommunityEvent = {
      event_id: "evt-kick",
      event_type: "member_kicked",
      payload: {
        community_id: "community-1",
        user_id: "user-1",
        voice_channel_ids: ["channel-1", "channel-2"],
      },
    };

    await moderation.apply(event, trace);

    expect(roomClient.removedParticipants).toEqual([
      { room: ROOM_1, identity: "user-1" },
      { room: ROOM_2, identity: "user-1" },
    ]);
    expect(await evictionCount(metrics)).toEqual({ kick: 1 });
  });

  it("removes banned members and records the ban metric", async () => {
    const { moderation, roomClient, metrics } = createHarness();
    const event: CommunityEvent = {
      event_id: "evt-ban",
      event_type: "member_banned",
      payload: {
        community_id: "community-1",
        user_id: "user-1",
        voice_channel_ids: ["channel-1"],
      },
    };

    await moderation.apply(event, trace);

    expect(roomClient.removedParticipants).toEqual([
      { room: ROOM_1, identity: "user-1" },
    ]);
    expect(await evictionCount(metrics)).toEqual({ ban: 1 });
  });

  it("falls back to every active room when the event omits voice_channel_ids", async () => {
    const { moderation, roomClient, metrics } = createHarness();

    await moderation.apply(
      {
        event_id: "evt-kick-2",
        event_type: "member_kicked",
        payload: {
          community_id: "community-1",
          user_id: "user-1",
          voice_channel_ids: [],
        },
      },
      trace,
    );

    expect(roomClient.removedParticipants).toHaveLength(2);
    expect(await evictionCount(metrics)).toEqual({ kick: 1 });
  });

  it("revokes publish permissions for timed-out members", async () => {
    const { moderation, roomClient, metrics } = createHarness();
    const event: CommunityEvent = {
      event_id: "evt-timeout",
      event_type: "member_timed_out",
      payload: {
        community_id: "community-1",
        user_id: "user-1",
        voice_channel_ids: ["channel-1"],
        timed_out_until: "2026-01-01T12:05:00.000Z",
      },
    };

    await moderation.apply(event, trace);

    expect(roomClient.permissionUpdates).toEqual([
      {
        room: ROOM_1,
        identity: "user-1",
        patch: {
          canPublish: false,
          canPublishSources: [],
          canPublishData: false,
          canSubscribe: true,
        },
      },
    ]);
    expect(await evictionCount(metrics)).toEqual({ timeout: 1 });
  });

  it("restores publish permissions when the timeout is cleared", async () => {
    const { moderation, roomClient, accessClient } = createHarness();
    const event: CommunityEvent = {
      event_id: "evt-cleared",
      event_type: "timeout_cleared",
      payload: {
        community_id: "community-1",
        user_id: "user-1",
        voice_channel_ids: ["channel-1"],
      },
    };

    await moderation.apply(event, trace);

    expect(accessClient.calls).toEqual([
      { channelId: "channel-1", userId: "user-1" },
    ]);
    expect(roomClient.permissionUpdates).toEqual([
      {
        room: ROOM_1,
        identity: "user-1",
        patch: {
          canPublish: true,
          canPublishSources: [
            TrackSource.MICROPHONE,
            TrackSource.CAMERA,
            TrackSource.SCREEN_SHARE,
            TrackSource.SCREEN_SHARE_AUDIO,
          ],
          canPublishData: true,
          canSubscribe: true,
        },
      },
    ]);
  });

  it("removes the participant when access was revoked during re-evaluation", async () => {
    const { moderation, roomClient, metrics } = createHarness({
      can_connect: false,
    });

    await moderation.apply(
      {
        event_id: "evt-cleared-2",
        event_type: "timeout_cleared",
        payload: {
          community_id: "community-1",
          user_id: "user-1",
          voice_channel_ids: ["channel-1"],
        },
      },
      trace,
    );

    expect(roomClient.removedParticipants).toEqual([
      { room: ROOM_1, identity: "user-1" },
    ]);
    expect(await evictionCount(metrics)).toEqual({ permission_revoked: 1 });
  });

  it("closes the room when the channel is deleted", async () => {
    const { moderation, roomClient, metrics } = createHarness();
    const event: CommunityEvent = {
      event_id: "evt-delete",
      event_type: "channel_deleted",
      payload: { community_id: "community-1", channel_id: "channel-1" },
    };

    await moderation.apply(event, trace);

    expect(roomClient.deletedRooms).toEqual([ROOM_1]);
    expect(await evictionCount(metrics)).toEqual({ channel_deleted: 1 });
  });

  it("re-checks only the affected participants on overwrite changes", async () => {
    const { moderation, accessClient, roomClient } = createHarness(
      (channelId, userId) => ({
        ...fullAccess(channelId, userId),
        can_speak: false,
      }),
    );

    await moderation.apply(
      {
        event_id: "evt-overwrite",
        event_type: "permission_overwrites_changed",
        payload: {
          community_id: "community-1",
          channel_id: "channel-1",
          affected_user_ids: ["user-1"],
        },
      },
      trace,
    );

    expect(accessClient.calls).toEqual([
      { channelId: "channel-1", userId: "user-1" },
    ]);
    expect(roomClient.permissionUpdates[0]?.patch.canPublish).toBe(true);
    expect(roomClient.permissionUpdates[0]?.patch.canPublishData).toBe(false);
  });

  it("re-checks every participant when no affected users are listed", async () => {
    const roomClient = createFakeRoomClient({
      participants: {
        [ROOM_1]: [
          makeParticipant({ identity: "user-1" }),
          makeParticipant({ identity: "user-2" }),
        ],
      },
    });
    const { moderation, accessClient } = createHarness({}, roomClient);

    await moderation.apply(
      {
        event_id: "evt-overwrite-2",
        event_type: "permission_overwrites_changed",
        payload: {
          community_id: "community-1",
          channel_id: "channel-1",
          affected_user_ids: [],
        },
      },
      trace,
    );

    expect(accessClient.calls).toEqual([
      { channelId: "channel-1", userId: "user-1" },
      { channelId: "channel-1", userId: "user-2" },
    ]);
  });

  it("re-evaluates a member whose roles changed", async () => {
    const { moderation, accessClient } = createHarness();

    await moderation.apply(
      {
        event_id: "evt-roles",
        event_type: "member_roles_changed",
        payload: {
          community_id: "community-1",
          user_id: "user-1",
          voice_channel_ids: ["channel-1"],
        },
      },
      trace,
    );

    expect(accessClient.calls).toEqual([
      { channelId: "channel-1", userId: "user-1" },
    ]);
  });

  it("skips rooms that are not voice rooms", async () => {
    const roomClient = createFakeRoomClient({ rooms: ["lobby"] });
    const { moderation, accessClient } = createHarness({}, roomClient);

    await moderation.apply(
      {
        event_id: "evt-lobby",
        event_type: "member_roles_changed",
        payload: {
          community_id: "community-1",
          user_id: "user-1",
          voice_channel_ids: [],
        },
      },
      trace,
    );

    expect(accessClient.calls).toEqual([]);
  });
});
