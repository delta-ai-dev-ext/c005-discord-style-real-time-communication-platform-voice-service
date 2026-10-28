import { describe, expect, it } from "bun:test";
import {
  LiveKitWebhookVerifier,
  toWebhookEvent,
} from "../../src/clients/webhookVerifier.ts";
import { startTrace } from "../../src/lib/trace.ts";
import { isAppError } from "../../src/models/errors.ts";
import { elapsedMinutes, WebhookService } from "../../src/services/webhookService.ts";
import {
  createTestLogger,
  createTestMetrics,
  signLiveKitWebhook,
  TEST_LIVEKIT_API_KEY,
  TEST_LIVEKIT_API_SECRET,
} from "../mocks/index.ts";
import type { Metrics } from "../../src/metrics.ts";

const trace = startTrace(null);

function verifier(): LiveKitWebhookVerifier {
  return new LiveKitWebhookVerifier(
    TEST_LIVEKIT_API_KEY,
    TEST_LIVEKIT_API_SECRET,
    createTestLogger(),
  );
}

/** prom-client materialises a zero-valued entry for label-less counters. */
async function counterTotal(
  counter: Metrics["participantsJoined"] | Metrics["sessionsMinutes"],
): Promise<number> {
  const metric = await counter.get();

  return metric.values.reduce((total, value) => total + value.value, 0);
}

const participantJoinedBody = JSON.stringify({
  event: "participant_joined",
  room: {
    name: "voice_channel-1",
    sid: "RM_1",
    creationTime: "1700000000",
  },
  participant: {
    identity: "user-1",
    sid: "PA_1",
    joinedAt: "1700000000",
  },
});

describe("LiveKitWebhookVerifier", () => {
  it("verifies a correctly signed webhook", async () => {
    const authHeader = await signLiveKitWebhook(participantJoinedBody);

    const event = await verifier().verify(participantJoinedBody, authHeader);

    expect(event.event).toBe("participant_joined");
    expect(event.roomName).toBe("voice_channel-1");
    expect(event.participantIdentity).toBe("user-1");
    expect(event.participantJoinedAtMs).toBe(1_700_000_000_000);
    expect(event.roomCreatedAtMs).toBe(1_700_000_000_000);
  });

  it("rejects a missing authorization header", async () => {
    await expect(
      verifier().verify(participantJoinedBody, null),
    ).rejects.toBeInstanceOf(Error);
  });

  it("rejects a body that does not match the signature", async () => {
    const authHeader = await signLiveKitWebhook(participantJoinedBody);
    const tamperedBody = participantJoinedBody.replace("user-1", "user-2");

    try {
      await verifier().verify(tamperedBody, authHeader);
      throw new Error("expected verification to fail");
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect((error as { status: number }).status).toBe(401);
    }
  });

  it("rejects a token signed with the wrong secret", async () => {
    const authHeader = await signLiveKitWebhook(
      participantJoinedBody,
      TEST_LIVEKIT_API_KEY,
      "wrong-secret",
    );

    await expect(
      verifier().verify(participantJoinedBody, authHeader),
    ).rejects.toThrow("Invalid LiveKit webhook signature");
  });
});

describe("toWebhookEvent", () => {
  it("tolerates missing room and participant blocks", () => {
    expect(toWebhookEvent({ event: "room_finished" })).toEqual({
      event: "room_finished",
    });
  });

  it("prefers millisecond timestamps when present", () => {
    const event = toWebhookEvent({
      event: "participant_left",
      room: { name: "voice_x", creationTimeMs: 1_700_000_000_000n },
      participant: { identity: "user-9", joinedAtMs: 1_700_000_100_000n },
    });

    expect(event.roomCreatedAtMs).toBe(1_700_000_000_000);
    expect(event.participantJoinedAtMs).toBe(1_700_000_100_000);
  });
});

describe("elapsedMinutes", () => {
  it("returns whole minutes between timestamps", () => {
    expect(elapsedMinutes(1_700_000_000_000, 1_700_000_120_000)).toBe(2);
  });

  it("clamps negative and unknown durations to zero", () => {
    expect(elapsedMinutes(1_700_000_120_000, 1_700_000_000_000)).toBe(0);
    expect(elapsedMinutes(undefined, 1_700_000_000_000)).toBe(0);
  });
});

describe("WebhookService", () => {
  function createService(now = 1_700_000_120_000) {
    const metrics = createTestMetrics();
    const logger = createTestLogger();
    const service = new WebhookService({
      verifier: new LiveKitWebhookVerifier(
        TEST_LIVEKIT_API_KEY,
        TEST_LIVEKIT_API_SECRET,
        logger,
      ),
      metrics,
      logger,
      clock: () => now,
    });

    return { service, metrics, logger };
  }

  it("counts participant joins", async () => {
    const { service, metrics } = createService();
    const authHeader = await signLiveKitWebhook(participantJoinedBody);

    const event = await service.handle(participantJoinedBody, authHeader, trace);

    expect(event.event).toBe("participant_joined");
    expect(await counterTotal(metrics.participantsJoined)).toBe(1);
    expect(await counterTotal(metrics.sessionsMinutes)).toBe(0);
  });

  it("accumulates session minutes on participant_left", async () => {
    const { service, metrics } = createService();
    const body = JSON.stringify({
      event: "participant_left",
      room: { name: "voice_channel-1", sid: "RM_1", creationTime: "1700000000" },
      participant: { identity: "user-1", sid: "PA_1", joinedAt: "1700000000" },
    });
    const authHeader = await signLiveKitWebhook(body);

    await service.handle(body, authHeader, trace);

    expect(await counterTotal(metrics.sessionsMinutes)).toBe(2);
  });

  it("accumulates session minutes on room_finished", async () => {
    const { service, metrics } = createService(1_700_000_180_000);
    const body = JSON.stringify({
      event: "room_finished",
      room: { name: "voice_channel-1", sid: "RM_1", creationTime: "1700000000" },
    });
    const authHeader = await signLiveKitWebhook(body);

    await service.handle(body, authHeader, trace);

    expect(await counterTotal(metrics.sessionsMinutes)).toBe(3);
  });

  it("ignores unrelated events", async () => {
    const { service, metrics } = createService();
    const body = JSON.stringify({
      event: "track_published",
      room: { name: "voice_channel-1", sid: "RM_1" },
    });
    const authHeader = await signLiveKitWebhook(body);

    const event = await service.handle(body, authHeader, trace);

    expect(event.event).toBe("track_published");
    expect(await counterTotal(metrics.participantsJoined)).toBe(0);
    expect(await counterTotal(metrics.sessionsMinutes)).toBe(0);
  });
});
