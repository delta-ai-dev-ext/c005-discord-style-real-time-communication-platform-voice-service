import { describe, expect, it, mock } from "bun:test";
import type { ParticipantInfo, RoomServiceClient } from "livekit-server-sdk";
import {
  isRoomNotFoundError,
  LiveKitRoomService,
  LiveKitTokenMinter,
  toRoomParticipant,
  TrackSource,
} from "../../src/clients/livekit.ts";
import { toLiveKitHttpUrl } from "../../src/clients/livekitUrl.ts";
import { createTestLogger, createTestMetrics } from "../mocks/index.ts";

describe("isRoomNotFoundError", () => {
  it("detects twirp not_found codes", () => {
    expect(isRoomNotFoundError({ code: "not_found" })).toBe(true);
  });

  it("detects 404 statuses", () => {
    expect(isRoomNotFoundError({ status: 404 })).toBe(true);
  });

  it("detects not-found messages for rooms and participants", () => {
    expect(isRoomNotFoundError(new Error("room not found"))).toBe(true);
    expect(isRoomNotFoundError(new Error("participant does not exist"))).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isRoomNotFoundError(new Error("permission denied"))).toBe(false);
    expect(isRoomNotFoundError(null)).toBe(false);
    expect(isRoomNotFoundError("boom")).toBe(false);
  });
});

describe("toRoomParticipant", () => {
  it("maps identity, name, join time and tracks", () => {
    const participant = toRoomParticipant({
      identity: "user-1",
      name: "Ada",
      joinedAt: 1_700_000_000n,
      joinedAtMs: 1_700_000_000_000n,
      tracks: [{ source: TrackSource.MICROPHONE, muted: false }],
    } as unknown as ParticipantInfo);

    expect(participant).toEqual({
      identity: "user-1",
      name: "Ada",
      joinedAtMs: 1_700_000_000_000,
      tracks: [{ source: TrackSource.MICROPHONE, muted: false }],
    });
  });

  it("falls back to second precision when joinedAtMs is absent", () => {
    const participant = toRoomParticipant({
      identity: "user-1",
      name: "",
      joinedAt: 1_700_000_000n,
      joinedAtMs: undefined,
      tracks: [],
    } as unknown as ParticipantInfo);

    expect(participant.joinedAtMs).toBe(1_700_000_000_000);
    expect(participant.name).toBeUndefined();
  });
});

describe("LiveKitRoomService", () => {
  function createAdapter(
    overrides: {
      listParticipants?: (room: string) => Promise<ParticipantInfo[]>;
      listRooms?: () => Promise<Array<{ name: string }>>;
      removeParticipant?: (room: string, identity: string) => Promise<void>;
      updateParticipant?: (
        room: string,
        identity: string,
        options: unknown,
      ) => Promise<unknown>;
      deleteRoom?: (room: string) => Promise<void>;
    } = {},
  ) {
    const client = {
      listParticipants: mock(
        overrides.listParticipants ?? (async () => [] as ParticipantInfo[]),
      ),
      listRooms: mock(
        overrides.listRooms ?? (async () => [] as Array<{ name: string }>),
      ),
      removeParticipant: mock(
        overrides.removeParticipant ?? (async () => undefined),
      ),
      updateParticipant: mock(
        overrides.updateParticipant ?? (async () => ({})),
      ),
      deleteRoom: mock(overrides.deleteRoom ?? (async () => undefined)),
    };

    const metrics = createTestMetrics();
    const logger = createTestLogger();
    const adapter = new LiveKitRoomService(
      client as unknown as RoomServiceClient,
      metrics,
      logger,
    );

    return { adapter, client, metrics, logger };
  }

  it("maps listed participants", async () => {
    const { adapter } = createAdapter({
      listParticipants: async () => [
        {
          identity: "user-1",
          name: "Ada",
          joinedAt: 1_700_000_000n,
          joinedAtMs: 1_700_000_000_000n,
          tracks: [],
        } as unknown as ParticipantInfo,
      ],
    });

    const participants = await adapter.listParticipants("voice_channel-1");

    expect(participants).toHaveLength(1);
    expect(participants[0]?.identity).toBe("user-1");
  });

  it("returns room names", async () => {
    const { adapter } = createAdapter({
      listRooms: async () => [{ name: "voice_a" }, { name: "voice_b" }],
    });

    expect(await adapter.listRoomNames()).toEqual(["voice_a", "voice_b"]);
  });

  it("forwards permission updates as LiveKit permissions", async () => {
    const { adapter, client } = createAdapter();

    await adapter.updateParticipantPermissions("voice_channel-1", "user-1", {
      canPublish: false,
      canPublishSources: [],
      canPublishData: false,
      canSubscribe: true,
    });

    expect(client.updateParticipant).toHaveBeenCalledWith(
      "voice_channel-1",
      "user-1",
      {
        permission: {
          canPublish: false,
          canPublishSources: [],
          canPublishData: false,
          canSubscribe: true,
        },
      },
    );
  });

  it("removes participants and deletes rooms", async () => {
    const { adapter, client } = createAdapter();

    await adapter.removeParticipant("voice_channel-1", "user-1");
    await adapter.deleteRoom("voice_channel-1");

    expect(client.removeParticipant).toHaveBeenCalledWith(
      "voice_channel-1",
      "user-1",
    );
    expect(client.deleteRoom).toHaveBeenCalledWith("voice_channel-1");
  });

  it("records duration and error metrics for failed calls", async () => {
    const { adapter, metrics } = createAdapter({
      listParticipants: async () => {
        throw new Error("livekit down");
      },
    });

    await expect(adapter.listParticipants("voice_channel-1")).rejects.toThrow(
      "livekit down",
    );

    const errors = await metrics.livekitApiErrors.get();
    expect(errors.values).toEqual([
      { labels: { operation: "list_participants" }, value: 1 },
    ]);

    const durations = await metrics.livekitApiDuration.get();
    expect(durations.values[0]?.labels.operation).toBe("list_participants");
  });
});

describe("LiveKitTokenMinter", () => {
  it("signs a JWT carrying identity, room and grants", async () => {
    const minter = new LiveKitTokenMinter(
      "test-key",
      "test-secret",
      () => 1_700_000_000_000,
    );

    const minted = await minter.mint({
      room: "voice_channel-1",
      identity: "user-1",
      name: "Ada",
      ttlSeconds: 600,
      grant: { room: "voice_channel-1", roomJoin: true, canPublish: true },
    });

    expect(minted.expiresAt.toISOString()).toBe(
      new Date(1_700_000_600_000).toISOString(),
    );

    const [, payload] = minted.token.split(".");
    const claims = JSON.parse(
      atob((payload ?? "").replace(/-/g, "+").replace(/_/g, "/")),
    ) as { sub: string; name: string; video: { room: string; roomJoin: boolean } };

    expect(claims.sub).toBe("user-1");
    expect(claims.name).toBe("Ada");
    expect(claims.video.room).toBe("voice_channel-1");
    expect(claims.video.roomJoin).toBe(true);
  });
});

describe("toLiveKitHttpUrl", () => {
  it("converts websocket urls to https", () => {
    expect(toLiveKitHttpUrl("wss://project.livekit.cloud")).toBe(
      "https://project.livekit.cloud",
    );
    expect(toLiveKitHttpUrl("ws://localhost:7880")).toBe("http://localhost:7880");
  });
});
