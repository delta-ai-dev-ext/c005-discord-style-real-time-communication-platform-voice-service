import { describe, expect, it } from "bun:test";
import { TrackSource } from "../../src/clients/livekit.ts";
import { upstreamUnavailable } from "../../src/models/errors.ts";
import {
  createFakeRoomClient,
  createTestAccessClient,
  createTestApp,
  createTestAuthenticator,
  createTestConfig,
  decodeJwtPayload,
  jsonRequest,
  makeParticipant,
  signLiveKitWebhook,
} from "../mocks/index.ts";

const TOKEN_PATH = "/v1/voice/channels/channel-1/token";
const PARTICIPANTS_PATH = "/v1/voice/channels/channel-1/participants";
const WEBHOOK_PATH = "/v1/webhooks/livekit";
const VOICE_ROOM = "voice_channel-1";

const authorizedRequest = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: {
    authorization: "Bearer clerk-session-jwt",
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  },
});

describe("POST /v1/voice/channels/:channel_id/token", () => {
  it("issues a short-lived LiveKit token with mapped grants", async () => {
    const harness = createTestApp();

    const response = await harness.app.handle(
      jsonRequest(TOKEN_PATH, authorizedRequest({ method: "POST" })),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      server_url: string;
      token: string;
      room: string;
      expires_at: string;
      grants: { can_speak: boolean; can_video: boolean };
    };

    expect(body.server_url).toBe("wss://livekit.test");
    expect(body.room).toBe(VOICE_ROOM);
    expect(body.grants).toEqual({ can_speak: true, can_video: true });
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());

    const claims = decodeJwtPayload(body.token) as {
      sub: string;
      iss: string;
      exp: number;
      video: {
        room: string;
        roomJoin: boolean;
        canPublish: boolean;
        canPublishData: boolean;
        canSubscribe: boolean;
        canPublishSources: string[];
      };
    };

    expect(claims.sub).toBe("user-1");
    expect(claims.iss).toBe("test-api-key");
    expect(claims.video.room).toBe(VOICE_ROOM);
    expect(claims.video.roomJoin).toBe(true);
    expect(claims.video.canSubscribe).toBe(true);
    expect(claims.video.canPublish).toBe(true);
    expect(claims.video.canPublishData).toBe(true);
    // LiveKit serialises track sources by name inside the JWT.
    expect(claims.video.canPublishSources).toEqual([
      "microphone",
      "camera",
      "screen_share",
      "screen_share_audio",
    ]);

    const ttlSeconds = claims.exp - Math.floor(Date.now() / 1000);
    expect(ttlSeconds).toBeGreaterThan(590);
    expect(ttlSeconds).toBeLessThanOrEqual(600);
  });

  it("mints a strictly listen-only token for timed-out members", async () => {
    const harness = createTestApp({
      accessClient: createTestAccessClient({
        timed_out_until: new Date(Date.now() + 300_000).toISOString(),
      }),
    });

    const response = await harness.app.handle(
      jsonRequest(TOKEN_PATH, authorizedRequest({ method: "POST" })),
    );

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      token: string;
      grants: { can_speak: boolean; can_video: boolean };
    };

    expect(body.grants).toEqual({ can_speak: false, can_video: false });

    const claims = decodeJwtPayload(body.token) as {
      video: {
        canPublish: boolean;
        canPublishData: boolean;
        canPublishSources: string[];
      };
    };

    expect(claims.video.canPublish).toBe(false);
    expect(claims.video.canPublishData).toBe(false);
    expect(claims.video.canPublishSources).toEqual([]);
  });

  it("rejects banned callers with 403 banned", async () => {
    const harness = createTestApp({
      accessClient: createTestAccessClient({ banned: true }),
    });

    const response = await harness.app.handle(
      jsonRequest(TOKEN_PATH, authorizedRequest({ method: "POST" })),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "banned",
        message: "Caller is banned from this community",
      },
    });
  });

  it("rejects callers without can_connect with 403 missing_permission", async () => {
    const harness = createTestApp({
      accessClient: createTestAccessClient({ can_connect: false }),
    });

    const response = await harness.app.handle(
      jsonRequest(TOKEN_PATH, authorizedRequest({ method: "POST" })),
    );

    expect(response.status).toBe(403);

    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_permission");
  });

  it("rejects a full room with 409 room_full", async () => {
    const harness = createTestApp({
      config: createTestConfig({ maxRoomCapacity: 1 }),
      roomClient: createFakeRoomClient({
        participants: {
          [VOICE_ROOM]: [makeParticipant({ identity: "user-2" })],
        },
      }),
    });

    const response = await harness.app.handle(
      jsonRequest(TOKEN_PATH, authorizedRequest({ method: "POST" })),
    );

    expect(response.status).toBe(409);

    const body = (await response.json()) as {
      error: { code: string; details?: { capacity: number } };
    };

    expect(body.error.code).toBe("room_full");
    expect(body.error.details).toEqual({ capacity: 1 });
  });

  it("requires a bearer token", async () => {
    const harness = createTestApp();

    const response = await harness.app.handle(
      jsonRequest(TOKEN_PATH, { method: "POST" }),
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );
  });

  it("rejects an invalid Clerk token", async () => {
    const harness = createTestApp({
      authenticator: createTestAuthenticator(),
    });

    const response = await harness.app.handle(
      jsonRequest(
        TOKEN_PATH,
        authorizedRequest({
          method: "POST",
          headers: { authorization: "Bearer invalid-token" },
        }),
      ),
    );

    expect(response.status).toBe(401);
  });

  it("rejects an unsupported HTTP auth scheme", async () => {
    const harness = createTestApp();

    const response = await harness.app.handle(
      jsonRequest(
        TOKEN_PATH,
        authorizedRequest({
          method: "POST",
          headers: { authorization: "Basic abc" },
        }),
      ),
    );

    expect(response.status).toBe(401);
  });

  it("validates the channel id", async () => {
    const harness = createTestApp();

    const response = await harness.app.handle(
      jsonRequest(
        "/v1/voice/channels/bad id/token",
        authorizedRequest({ method: "POST" }),
      ),
    );

    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("fails closed with 503 when community_service is unavailable", async () => {
    const harness = createTestApp({
      accessClient: {
        getChannelAccess: async () => {
          throw upstreamUnavailable();
        },
      },
    });

    const response = await harness.app.handle(
      jsonRequest(TOKEN_PATH, authorizedRequest({ method: "POST" })),
    );

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "upstream_unavailable",
    );
  });
});

describe("GET /v1/voice/channels/:channel_id/participants", () => {
  it("lists participants mapped from LiveKit", async () => {
    const harness = createTestApp({
      roomClient: createFakeRoomClient({
        participants: {
          [VOICE_ROOM]: [
            makeParticipant({
              identity: "user-1",
              joinedAtMs: 1_700_000_000_000,
              tracks: [{ source: TrackSource.MICROPHONE, muted: false }],
            }),
            makeParticipant({
              identity: "user-2",
              joinedAtMs: 1_700_000_060_000,
              tracks: [{ source: TrackSource.CAMERA, muted: false }],
            }),
          ],
        },
      }),
    });

    const response = await harness.app.handle(
      jsonRequest(PARTICIPANTS_PATH, authorizedRequest()),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        user_id: "user-1",
        is_muted: false,
        has_video: false,
        joined_at: new Date(1_700_000_000_000).toISOString(),
      },
      {
        user_id: "user-2",
        is_muted: true,
        has_video: true,
        joined_at: new Date(1_700_000_060_000).toISOString(),
      },
    ]);
  });

  it("returns an empty list when the room does not exist", async () => {
    const harness = createTestApp({
      roomClient: createFakeRoomClient({ missingRooms: [VOICE_ROOM] }),
    });

    const response = await harness.app.handle(
      jsonRequest(PARTICIPANTS_PATH, authorizedRequest()),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("requires can_view", async () => {
    const harness = createTestApp({
      accessClient: createTestAccessClient({ can_view: false }),
    });

    const response = await harness.app.handle(
      jsonRequest(PARTICIPANTS_PATH, authorizedRequest()),
    );

    expect(response.status).toBe(403);

    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_permission");
  });
});

describe("POST /v1/webhooks/livekit", () => {
  const body = JSON.stringify({
    event: "participant_joined",
    room: { name: VOICE_ROOM, sid: "RM_1", creationTime: "1700000000" },
    participant: { identity: "user-1", sid: "PA_1", joinedAt: "1700000000" },
  });

  it("accepts a correctly signed webhook and counts the join", async () => {
    const harness = createTestApp();
    const authHeader = await signLiveKitWebhook(body);

    const response = await harness.app.handle(
      jsonRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/webhook+json",
          authorization: authHeader,
        },
        body,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: true,
      event: "participant_joined",
    });

    const joins = await harness.metrics.participantsJoined.get();
    const total = joins.values.reduce((sum, value) => sum + value.value, 0);
    expect(total).toBe(1);
  });

  it("rejects a webhook without a signature", async () => {
    const harness = createTestApp();

    const response = await harness.app.handle(
      jsonRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: { "content-type": "application/webhook+json" },
        body,
      }),
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );
  });

  it("rejects a tampered body", async () => {
    const harness = createTestApp();
    const authHeader = await signLiveKitWebhook(body);

    const response = await harness.app.handle(
      jsonRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/webhook+json",
          authorization: authHeader,
        },
        body: body.replace("user-1", "user-2"),
      }),
    );

    expect(response.status).toBe(401);
  });

  it("rejects an empty body", async () => {
    const harness = createTestApp();

    const response = await harness.app.handle(
      jsonRequest(WEBHOOK_PATH, {
        method: "POST",
        headers: { "content-type": "application/webhook+json" },
        body: "",
      }),
    );

    expect(response.status).toBe(401);
  });
});

describe("probes", () => {
  it("reports liveness at the root and under /v1", async () => {
    const harness = createTestApp();

    for (const path of ["/healthz", "/v1/healthz"]) {
      const response = await harness.app.handle(jsonRequest(path));

      expect(response.status).toBe(200);

      const payload = (await response.json()) as {
        status: string;
        timestamp: string;
      };
      expect(payload.status).toBe("ok");
      expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
    }
  });

  it("reports readiness once the consumer holds partitions", async () => {
    const harness = createTestApp({ ready: true });

    for (const path of ["/readyz", "/v1/readyz"]) {
      const response = await harness.app.handle(jsonRequest(path));

      expect(response.status).toBe(200);
      expect(((await response.json()) as { status: string }).status).toBe("ok");
    }
  });

  it("returns 503 from readiness before Kafka assignment", async () => {
    const harness = createTestApp({ ready: false });

    for (const path of ["/readyz", "/v1/readyz"]) {
      const response = await harness.app.handle(jsonRequest(path));

      expect(response.status).toBe(503);
      expect(((await response.json()) as { status: string }).status).toBe(
        "not_ok",
      );
    }
  });
});

describe("metrics and errors", () => {
  it("exposes the Prometheus registry", async () => {
    const harness = createTestApp();

    const response = await harness.app.handle(jsonRequest("/metrics"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");

    const text = await response.text();
    expect(text).toContain("voice_tokens_issued_total");
    expect(text).toContain("voice_livekit_api_duration_seconds");
    expect(text).toContain("http_request_duration_seconds");
    expect(text).toContain("kafka_consumer_lag");
  });

  it("returns a structured 404 envelope", async () => {
    const harness = createTestApp();

    const response = await harness.app.handle(jsonRequest("/v1/unknown"));

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "not_found",
    );
  });

  it("records request metrics and access logs with low-cardinality labels", async () => {
    const harness = createTestApp();

    await harness.app.handle(
      jsonRequest(TOKEN_PATH, authorizedRequest({ method: "POST" })),
    );

    const duration = await harness.metrics.httpRequestDuration.get();

    const tokenRoute = duration.values.find(
      (value) => value.labels.route === "/v1/voice/channels/:channel_id/token",
    );

    expect(tokenRoute?.labels.method).toBe("POST");
    expect(tokenRoute?.labels.status_class).toBe("2xx");

    const logEntry = harness.logger.entries.find(
      (entry) => entry.message === "http request handled",
    );

    expect(logEntry?.meta?.route).toBe("/v1/voice/channels/:channel_id/token");
    expect(logEntry?.meta?.method).toBe("POST");
    expect(logEntry?.meta?.status_code).toBe(200);
    expect(typeof logEntry?.meta?.trace_id).toBe("string");
  });
});
