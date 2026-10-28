import { describe, expect, it, mock } from "bun:test";
import { TrackSource, type MintTokenInput, type TokenMinter } from "../../src/clients/livekit.ts";
import { startTrace } from "../../src/lib/trace.ts";
import { toUserId } from "../../src/models/ids.ts";
import {
  mapPermissionPatch,
  mapVideoGrant,
  TokenService,
} from "../../src/services/tokenService.ts";
import { createTestLogger, createTestMetrics } from "../mocks/index.ts";

const trace = startTrace(null);

describe("mapVideoGrant", () => {
  it("grants join, subscribe and full publishing for a speaking member with video", () => {
    const grant = mapVideoGrant("voice_channel-1", true, true);

    expect(grant.room).toBe("voice_channel-1");
    expect(grant.roomJoin).toBe(true);
    expect(grant.canSubscribe).toBe(true);
    expect(grant.canPublish).toBe(true);
    expect(grant.canPublishData).toBe(true);
    expect(grant.canPublishSources).toEqual([
      TrackSource.MICROPHONE,
      TrackSource.CAMERA,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO,
    ]);
  });

  it("grants only microphone publishing when video is not allowed", () => {
    const grant = mapVideoGrant("voice_channel-1", true, false);

    expect(grant.canPublish).toBe(true);
    expect(grant.canPublishSources).toEqual([TrackSource.MICROPHONE]);
  });

  it("grants camera and screen share without microphone when only video is allowed", () => {
    const grant = mapVideoGrant("voice_channel-1", false, true);

    expect(grant.canPublish).toBe(true);
    expect(grant.canPublishData).toBe(false);
    expect(grant.canPublishSources).toEqual([
      TrackSource.CAMERA,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO,
    ]);
  });

  it("produces a strictly listen-only grant for timed-out members", () => {
    const grant = mapVideoGrant("voice_channel-1", false, false);

    expect(grant.roomJoin).toBe(true);
    expect(grant.canSubscribe).toBe(true);
    expect(grant.canPublish).toBe(false);
    expect(grant.canPublishData).toBe(false);
    expect(grant.canPublishSources).toEqual([]);
  });
});

describe("mapPermissionPatch", () => {
  it("mirrors the token grants for an already connected participant", () => {
    expect(mapPermissionPatch(true, true)).toEqual({
      canPublish: true,
      canPublishSources: [
        TrackSource.MICROPHONE,
        TrackSource.CAMERA,
        TrackSource.SCREEN_SHARE,
        TrackSource.SCREEN_SHARE_AUDIO,
      ],
      canPublishData: true,
      canSubscribe: true,
    });
  });

  it("revokes publishing for timeouts", () => {
    expect(mapPermissionPatch(false, false)).toEqual({
      canPublish: false,
      canPublishSources: [],
      canPublishData: false,
      canSubscribe: true,
    });
  });
});

function createFakeMinter(): TokenMinter & { calls: MintTokenInput[] } {
  const calls: MintTokenInput[] = [];

  return {
    calls,
    mint: mock(async (input: MintTokenInput) => {
      calls.push(input);

      return {
        token: "signed.jwt.token",
        expiresAt: new Date(1_700_000_600_000),
      };
    }),
  };
}

describe("TokenService", () => {
  it("mints a token with the platform identity and 10 minute ttl", async () => {
    const minter = createFakeMinter();
    const metrics = createTestMetrics();
    const service = new TokenService({
      minter,
      serverUrl: "wss://livekit.test",
      ttlSeconds: 600,
      metrics,
      logger: createTestLogger(),
    });

    const response = await service.issue({
      room: "voice_channel-1",
      userId: toUserId("user-1"),
      displayName: "ada",
      canSpeak: true,
      canVideo: false,
      trace,
    });

    expect(minter.calls).toHaveLength(1);
    const call = minter.calls[0];
    expect(call?.identity).toBe("user-1");
    expect(call?.name).toBe("ada");
    expect(call?.ttlSeconds).toBe(600);
    expect(call?.grant.room).toBe("voice_channel-1");
    expect(call?.grant.canPublish).toBe(true);

    expect(response).toEqual({
      server_url: "wss://livekit.test",
      token: "signed.jwt.token",
      room: "voice_channel-1",
      expires_at: new Date(1_700_000_600_000).toISOString(),
      grants: { can_speak: true, can_video: false },
    });

    const metric = await metrics.tokensIssued.get();
    expect(metric.values).toEqual([{ labels: { grant: "full" }, value: 1 }]);
  });

  it("labels listen-only tokens and omits the display name when unknown", async () => {
    const minter = createFakeMinter();
    const metrics = createTestMetrics();
    const service = new TokenService({
      minter,
      serverUrl: "wss://livekit.test",
      ttlSeconds: 600,
      metrics,
      logger: createTestLogger(),
    });

    await service.issue({
      room: "voice_channel-1",
      userId: toUserId("user-1"),
      canSpeak: false,
      canVideo: false,
      trace,
    });

    expect(minter.calls[0]?.name).toBeUndefined();
    expect(minter.calls[0]?.grant.canPublish).toBe(false);

    const metric = await metrics.tokensIssued.get();
    expect(metric.values).toEqual([{ labels: { grant: "listen_only" }, value: 1 }]);
  });
});
