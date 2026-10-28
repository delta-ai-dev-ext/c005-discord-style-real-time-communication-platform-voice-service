import { describe, expect, it, mock } from "bun:test";
import {
  BoundedEventDeduplicator,
  CommunityEventsConsumer,
  type EachBatchPayloadLike,
  type EventProcessor,
  type KafkaConsumerLike,
  type KafkaMessageLike,
} from "../../src/consumers/communityEventsConsumer.ts";
import { startTrace } from "../../src/lib/trace.ts";
import type { CommunityEvent } from "../../src/models/events.ts";
import { createTestLogger, createTestMetrics } from "../mocks/index.ts";

const KICK_EVENT = {
  event_id: "evt-1",
  event_type: "member_kicked",
  occurred_at: "2026-01-01T12:00:00.000Z",
  payload: {
    community_id: "community-1",
    user_id: "user-1",
    voice_channel_ids: ["channel-1", "channel-2"],
  },
};

interface FakeKafkaConsumer {
  readonly consumer: KafkaConsumerLike;
  readonly listeners: Map<string, (payload: { payload?: unknown }) => void>;
  readonly subscriptions: Array<{ topic: string; fromBeginning?: boolean }>;
  batchHandler(): (payload: EachBatchPayloadLike) => Promise<void>;
}

function createFakeKafkaConsumer(): FakeKafkaConsumer {
  const listeners = new Map<string, (payload: { payload?: unknown }) => void>();
  const subscriptions: Array<{ topic: string; fromBeginning?: boolean }> = [];
  let handler: ((payload: EachBatchPayloadLike) => Promise<void>) | undefined;

  const consumer: KafkaConsumerLike = {
    connect: mock(async () => undefined),
    subscribe: mock(
      async (subscription: { topic: string; fromBeginning?: boolean }) => {
        subscriptions.push(subscription);
      },
    ),
    run: mock(
      async (config: {
        eachBatch: (payload: EachBatchPayloadLike) => Promise<void>;
        eachBatchAutoResolve?: boolean;
      }) => {
        handler = config.eachBatch;
      },
    ),
    disconnect: mock(async () => undefined),
    isRunning: () => true,
    on: (event, listener) => {
      listeners.set(event, listener);
    },
  };

  return {
    consumer,
    listeners,
    subscriptions,
    batchHandler: () => {
      if (!handler) {
        throw new Error("consumer.run was not called");
      }

      return handler;
    },
  };
}

function createProcessor(): EventProcessor & {
  readonly events: CommunityEvent[];
  readonly traces: string[];
} {
  const events: CommunityEvent[] = [];
  const traces: string[] = [];

  return {
    events,
    traces,
    process: mock(async (event: CommunityEvent, trace) => {
      events.push(event);
      traces.push(trace.traceId);
    }),
  };
}

function createConsumer(
  processor: EventProcessor = createProcessor(),
  deduplicator?: BoundedEventDeduplicator,
) {
  const fake = createFakeKafkaConsumer();
  const metrics = createTestMetrics();
  const logger = createTestLogger();
  const consumer = new CommunityEventsConsumer({
    topic: "community_events",
    groupId: "voice_service",
    createConsumer: () => fake.consumer,
    processor,
    logger,
    metrics,
    ...(deduplicator ? { deduplicator } : {}),
  });

  return { consumer, fake, metrics, logger, processor };
}

function message(payload: unknown, headers?: Record<string, { value: Uint8Array }>): KafkaMessageLike {
  return {
    offset: "1",
    value: new TextEncoder().encode(
      typeof payload === "string" ? payload : JSON.stringify(payload),
    ),
    ...(headers ? { headers } : {}),
  };
}

describe("CommunityEventsConsumer", () => {
  it("subscribes to the community events topic and exposes readiness only after assignment", async () => {
    const { consumer, fake } = createConsumer();

    await consumer.start();

    expect(fake.subscriptions).toEqual([
      { topic: "community_events", fromBeginning: false },
    ]);
    expect(consumer.isReady()).toBe(false);

    const joinListener = fake.listeners.get("consumer.group_join");
    expect(joinListener).toBeDefined();
    joinListener?.({
      payload: { memberAssignment: { community_events: [0, 1, 2] } },
    });

    expect(consumer.assignmentCount).toBe(3);
    expect(consumer.isReady()).toBe(true);
  });

  it("drops readiness when the consumer crashes", async () => {
    const { consumer, fake } = createConsumer();

    await consumer.start();
    fake.listeners.get("consumer.group_join")?.({
      payload: { memberAssignment: { community_events: [0] } },
    });
    expect(consumer.isReady()).toBe(true);

    fake.listeners.get("consumer.crash")?.({ payload: "boom" });
    expect(consumer.isReady()).toBe(false);
  });

  it("applies a moderation event and propagates the traceparent header", async () => {
    const processor = createProcessor();
    const { consumer } = createConsumer(processor);
    const traceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    await consumer.handleMessage(
      message(KICK_EVENT, {
        traceparent: { value: new TextEncoder().encode(traceparent) },
      }),
    );

    expect(processor.events).toHaveLength(1);
    expect(processor.events[0]?.event_type).toBe("member_kicked");
    expect(processor.traces[0]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("starts a fresh trace when the message carries no traceparent", async () => {
    const processor = createProcessor();
    const { consumer } = createConsumer(processor);

    await consumer.handleMessage(message(KICK_EVENT));

    expect(processor.traces[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("deduplicates redelivered events by event_id", async () => {
    const processor = createProcessor();
    const { consumer } = createConsumer(processor);

    await consumer.handleMessage(message(KICK_EVENT));
    await consumer.handleMessage(message(KICK_EVENT));

    expect(processor.events).toHaveLength(1);
  });

  it("ignores unsupported event types", async () => {
    const processor = createProcessor();
    const { consumer } = createConsumer(processor);

    await consumer.handleMessage(
      message({ event_id: "evt-9", event_type: "message_created", payload: {} }),
    );

    expect(processor.events).toHaveLength(0);
  });

  it("ignores invalid JSON, envelopes and payloads", async () => {
    const processor = createProcessor();
    const { consumer } = createConsumer(processor);

    await consumer.handleMessage(message("{not json"));
    await consumer.handleMessage(message({ event_type: "member_kicked" }));
    await consumer.handleMessage(
      message({
        event_id: "evt-2",
        event_type: "member_kicked",
        payload: { community_id: "community-1" },
      }),
    );
    await consumer.handleMessage({ offset: "2", value: null });

    expect(processor.events).toHaveLength(0);
  });

  it("keeps consuming when a handler throws", async () => {
    const failingProcessor: EventProcessor = {
      process: mock(async () => {
        throw new Error("livekit down");
      }),
    };
    const { consumer, logger } = createConsumer(failingProcessor);

    await consumer.handleMessage(message(KICK_EVENT));

    expect(logger.messages()).toContain("failed to apply community event");
  });

  it("processes each batch and records consumer lag", async () => {
    const processor = createProcessor();
    const { consumer, fake, metrics } = createConsumer(processor);

    await consumer.start();
    await fake.batchHandler()({
      batch: {
        topic: "community_events",
        partition: 0,
        highWatermark: "10",
        messages: [
          { offset: "7", value: message(KICK_EVENT).value },
          { offset: "8", value: message({ ...KICK_EVENT, event_id: "evt-2" }).value },
        ],
      },
    });

    expect(processor.events).toHaveLength(2);

    const lag = await metrics.kafkaConsumerLag.get();
    expect(lag.values).toEqual([
      {
        labels: { topic: "community_events", group: "voice_service" },
        value: 1,
      },
    ]);
  });

  it("disconnects and clears readiness on stop", async () => {
    const { consumer, fake } = createConsumer();

    await consumer.start();
    fake.listeners.get("consumer.group_join")?.({
      payload: { memberAssignment: { community_events: [0] } },
    });

    await consumer.stop();

    expect(fake.consumer.disconnect).toHaveBeenCalledTimes(1);
    expect(consumer.isReady()).toBe(false);
  });

  it("is a no-op when stopped before starting", async () => {
    const { consumer } = createConsumer();

    await expect(consumer.stop()).resolves.toBeUndefined();
  });

  it("counts zero partitions for unexpected join payloads", async () => {
    const { consumer, fake } = createConsumer();

    await consumer.start();
    fake.listeners.get("consumer.group_join")?.({ payload: undefined });

    expect(consumer.isReady()).toBe(false);
  });
});

describe("BoundedEventDeduplicator", () => {
  it("reports the first sighting of an id only once", () => {
    const deduplicator = new BoundedEventDeduplicator(2);

    expect(deduplicator.markIfNew("a")).toBe(true);
    expect(deduplicator.markIfNew("a")).toBe(false);
    expect(deduplicator.size).toBe(1);
  });

  it("evicts the oldest ids once the bound is reached", () => {
    const deduplicator = new BoundedEventDeduplicator(2);

    deduplicator.markIfNew("a");
    deduplicator.markIfNew("b");
    deduplicator.markIfNew("c");

    expect(deduplicator.size).toBe(2);
    expect(deduplicator.markIfNew("a")).toBe(true);
  });
});

describe("consumer trace helpers", () => {
  it("creates trace contexts for tests", () => {
    expect(startTrace(null).traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
