import { describe, expect, it } from "bun:test";
import { TrackSource } from "../../src/clients/livekit.ts";
import { isAppError } from "../../src/models/errors.ts";
import { toChannelId } from "../../src/models/ids.ts";
import { RoomService, toParticipantSummary } from "../../src/services/roomService.ts";
import {
  createFakeRoomClient,
  createTestLogger,
  createTestMetrics,
  makeParticipant,
} from "../mocks/index.ts";

const channelId = toChannelId("channel-1");
const ROOM = "voice_channel-1";

function createService(
  roomClient = createFakeRoomClient(),
  maxRoomCapacity = 2,
) {
  const metrics = createTestMetrics();

  return {
    service: new RoomService({
      client: roomClient.client,
      maxRoomCapacity,
      metrics,
      logger: createTestLogger(),
    }),
    metrics,
    roomClient,
  };
}

describe("toParticipantSummary", () => {
  it("reports muted when no microphone track is published", () => {
    const summary = toParticipantSummary(makeParticipant({ identity: "user-1" }));

    expect(summary).toEqual({
      user_id: "user-1",
      is_muted: true,
      has_video: false,
      joined_at: new Date(1_700_000_000_000).toISOString(),
    });
  });

  it("reports unmuted when the microphone track is live", () => {
    const summary = toParticipantSummary(
      makeParticipant({
        identity: "user-2",
        tracks: [{ source: TrackSource.MICROPHONE, muted: false }],
      }),
    );

    expect(summary.is_muted).toBe(false);
    expect(summary.has_video).toBe(false);
  });

  it("reports muted when the microphone track is muted", () => {
    const summary = toParticipantSummary(
      makeParticipant({
        identity: "user-3",
        tracks: [{ source: TrackSource.MICROPHONE, muted: true }],
      }),
    );

    expect(summary.is_muted).toBe(true);
  });

  it("detects camera and screen share as video", () => {
    const camera = toParticipantSummary(
      makeParticipant({
        identity: "user-4",
        tracks: [{ source: TrackSource.CAMERA, muted: false }],
      }),
    );
    const screenShare = toParticipantSummary(
      makeParticipant({
        identity: "user-5",
        tracks: [{ source: TrackSource.SCREEN_SHARE, muted: true }],
      }),
    );

    expect(camera.has_video).toBe(true);
    expect(screenShare.has_video).toBe(true);
  });
});

describe("RoomService", () => {
  it("returns participants for an existing room", async () => {
    const roomClient = createFakeRoomClient({
      participants: {
        [ROOM]: [makeParticipant({ identity: "user-1" })],
      },
    });
    const { service } = createService(roomClient);

    const participants = await service.listParticipants(channelId);

    expect(participants).toHaveLength(1);
    expect(participants[0]?.user_id).toBe("user-1");
  });

  it("returns an empty list when the LiveKit room does not exist", async () => {
    const roomClient = createFakeRoomClient({ missingRooms: [ROOM] });
    const { service } = createService(roomClient);

    expect(await service.listParticipants(channelId)).toEqual([]);
  });

  it("rejects a token request when the room is at capacity", async () => {
    const roomClient = createFakeRoomClient({
      participants: {
        [ROOM]: [
          makeParticipant({ identity: "user-1" }),
          makeParticipant({ identity: "user-2" }),
        ],
      },
    });
    const { service, metrics } = createService(roomClient);

    try {
      await service.assertCapacity(ROOM);
      throw new Error("expected assertCapacity to throw");
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect((error as { status: number }).status).toBe(409);
      expect((error as { code: string }).code).toBe("room_full");
    }

    const rejections = await metrics.roomFullRejections.get();
    expect(rejections.values[0]?.value).toBe(1);
  });

  it("allows a request below capacity", async () => {
    const roomClient = createFakeRoomClient({
      participants: { [ROOM]: [makeParticipant({ identity: "user-1" })] },
    });
    const { service } = createService(roomClient);

    await expect(service.assertCapacity(ROOM)).resolves.toBeUndefined();
  });

  it("treats a missing room as empty for capacity checks", async () => {
    const roomClient = createFakeRoomClient({ missingRooms: [ROOM] });
    const { service } = createService(roomClient);

    await expect(service.assertCapacity(ROOM)).resolves.toBeUndefined();
  });

  it("removes participants and tolerates absent participants", async () => {
    const roomClient = createFakeRoomClient({
      participants: { [ROOM]: [makeParticipant({ identity: "user-1" })] },
    });
    const { service } = createService(roomClient);

    expect(await service.removeParticipant(ROOM, "user-1")).toBe(true);
    expect(roomClient.removedParticipants).toEqual([
      { room: ROOM, identity: "user-1" },
    ]);

    roomClient.missingRooms.add("voice_missing");
    expect(await service.removeParticipant("voice_missing", "user-1")).toBe(false);
  });

  it("applies permission patches to connected participants", async () => {
    const roomClient = createFakeRoomClient({
      participants: { [ROOM]: [makeParticipant({ identity: "user-1" })] },
    });
    const { service } = createService(roomClient);

    const applied = await service.applyPermissions(ROOM, "user-1", {
      canPublish: false,
      canPublishSources: [],
      canPublishData: false,
      canSubscribe: true,
    });

    expect(applied).toBe(true);
    expect(roomClient.permissionUpdates).toEqual([
      {
        room: ROOM,
        identity: "user-1",
        patch: {
          canPublish: false,
          canPublishSources: [],
          canPublishData: false,
          canSubscribe: true,
        },
      },
    ]);
  });

  it("closes rooms and reports whether the room existed", async () => {
    const roomClient = createFakeRoomClient({
      participants: { [ROOM]: [makeParticipant({ identity: "user-1" })] },
    });
    const { service } = createService(roomClient);

    expect(await service.deleteRoom(ROOM)).toBe(true);
    expect(roomClient.deletedRooms).toEqual([ROOM]);

    roomClient.missingRooms.add("voice_unknown");
    expect(await service.deleteRoom("voice_unknown")).toBe(false);
  });

  it("propagates unexpected delete failures", async () => {
    const roomClient = createFakeRoomClient();
    roomClient.client.deleteRoom = async () => {
      throw new Error("livekit exploded");
    };
    const { service } = createService(roomClient);

    await expect(service.deleteRoom(ROOM)).rejects.toThrow("livekit exploded");
  });

  it("derives target rooms from the event payload or from active rooms", async () => {
    const roomClient = createFakeRoomClient({ rooms: ["voice_a", "voice_b"] });
    const { service } = createService(roomClient);

    expect(await service.targetRooms(["channel-1", "channel-2"])).toEqual([
      "voice_channel-1",
      "voice_channel-2",
    ]);
    expect(await service.targetRooms([])).toEqual(["voice_a", "voice_b"]);
  });

  it("uses the configured room capacity", async () => {
    const roomClient = createFakeRoomClient({
      participants: {
        [ROOM]: [
          makeParticipant({ identity: "user-1" }),
          makeParticipant({ identity: "user-2" }),
          makeParticipant({ identity: "user-3" }),
        ],
      },
    });
    const { service } = createService(roomClient, 3);

    await expect(service.assertCapacity(ROOM)).rejects.toThrow();
  });

  it("wraps unexpected LiveKit failures as internal errors", async () => {
    const roomClient = createFakeRoomClient();
    roomClient.client.listParticipants = async () => {
      throw new Error("livekit exploded");
    };

    const { service } = createService(roomClient);

    await expect(service.listParticipants(channelId)).rejects.toThrow(
      "Failed to list LiveKit participants",
    );
  });

  it("wraps unexpected room listing failures", async () => {
    const roomClient = createFakeRoomClient();
    roomClient.client.listRoomNames = async () => {
      throw new Error("livekit exploded");
    };
    const { service } = createService(roomClient);

    await expect(service.listActiveRoomNames()).rejects.toThrow(
      "Failed to list LiveKit rooms",
    );
  });
});
