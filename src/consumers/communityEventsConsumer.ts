import type { Logger } from "../logger.ts";
import { traceLogFields, startTrace, type TraceContext } from "../lib/trace.ts";
import type { Metrics } from "../metrics.ts";
import {
  communityEventEnvelopeSchema,
  communityEventSchema,
  isSupportedEventType,
  type CommunityEvent,
} from "../models/events.ts";

/** Anything that can apply a validated moderation event. */
export interface EventProcessor {
  process(event: CommunityEvent, trace: TraceContext): Promise<void>;
}

export interface KafkaHeaderValue {
  readonly value: Uint8Array | null;
}

export interface KafkaMessageLike {
  readonly offset: string;
  readonly value: Uint8Array | null;
  readonly headers?: Record<string, KafkaHeaderValue | undefined>;
}

export interface KafkaBatchLike {
  readonly topic: string;
  readonly partition: number;
  readonly highWatermark: string;
  readonly messages: KafkaMessageLike[];
}

export interface EachBatchPayloadLike {
  readonly batch: KafkaBatchLike;
}

export interface KafkaConsumerLike {
  connect(): Promise<void>;
  subscribe(subscription: { topic: string; fromBeginning?: boolean }): Promise<void>;
  run(config: {
    eachBatch: (payload: EachBatchPayloadLike) => Promise<void>;
    eachBatchAutoResolve?: boolean;
  }): Promise<void>;
  disconnect(): Promise<void>;
  isRunning(): boolean;
  on(
    event: "consumer.group_join" | "consumer.crash" | "consumer.stop",
    listener: (payload: { payload?: unknown }) => void,
  ): void;
}

export type KafkaConsumerFactory = () => KafkaConsumerLike;

/**
 * Best-effort, bounded `event_id` dedupe. Deliberately in-memory: the service is
 * stateless and cannot persist seen ids, and every handler is idempotent.
 */
export class BoundedEventDeduplicator {
  private readonly seen = new Set<string>();

  constructor(private readonly maxEntries = 10_000) {}

  /** Returns `true` the first time an id is observed. */
  markIfNew(eventId: string): boolean {
    if (this.seen.has(eventId)) {
      return false;
    }

    this.seen.add(eventId);

    if (this.seen.size > this.maxEntries) {
      const oldest = this.seen.values().next();

      if (!oldest.done) {
        this.seen.delete(oldest.value);
      }
    }

    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export interface CommunityEventsConsumerOptions {
  readonly topic: string;
  readonly groupId: string;
  readonly createConsumer: KafkaConsumerFactory;
  readonly processor: EventProcessor;
  readonly logger: Logger;
  readonly metrics: Pick<Metrics, "kafkaConsumerLag">;
  readonly deduplicator?: BoundedEventDeduplicator;
}

/**
 * Consumes `community_events` and applies moderation actions to LiveKit.
 *
 * Readiness depends on real partition assignment (`consumer.group_join`), which
 * is what `/readyz` checks.
 */
export class CommunityEventsConsumer {
  private consumer: KafkaConsumerLike | undefined;
  private running = false;
  private assignedPartitions = 0;
  private readonly deduplicator: BoundedEventDeduplicator;

  constructor(private readonly options: CommunityEventsConsumerOptions) {
    this.deduplicator =
      options.deduplicator ?? new BoundedEventDeduplicator();
  }

  /** True only when consuming *and* holding at least one partition. */
  isReady(): boolean {
    return this.running && this.assignedPartitions > 0;
  }

  get assignmentCount(): number {
    return this.assignedPartitions;
  }

  async start(): Promise<void> {
    if (this.consumer) {
      return;
    }

    const consumer = this.options.createConsumer();
    this.consumer = consumer;

    consumer.on("consumer.group_join", (event) => {
      this.assignedPartitions = countAssignedPartitions(event.payload);
      this.options.logger.info("kafka consumer group joined", {
        group: this.options.groupId,
        topic: this.options.topic,
        assigned_partitions: this.assignedPartitions,
      });
    });

    consumer.on("consumer.crash", (event) => {
      this.assignedPartitions = 0;
      this.options.logger.error("kafka consumer crashed", {
        group: this.options.groupId,
        error: String(event.payload ?? "unknown"),
      });
    });

    consumer.on("consumer.stop", () => {
      this.assignedPartitions = 0;
    });

    await consumer.connect();
    await consumer.subscribe({
      topic: this.options.topic,
      fromBeginning: false,
    });

    await consumer.run({
      eachBatchAutoResolve: true,
      eachBatch: async ({ batch }) => {
        // Holding a batch proves assignment even if the join event was missed.
        this.assignedPartitions = Math.max(this.assignedPartitions, 1);

        for (const message of batch.messages) {
          await this.handleMessage(message);
        }

        this.recordLag(batch);
      },
    });

    this.running = true;
    this.options.logger.info("kafka consumer started", {
      group: this.options.groupId,
      topic: this.options.topic,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.assignedPartitions = 0;

    if (!this.consumer) {
      return;
    }

    const consumer = this.consumer;
    this.consumer = undefined;

    try {
      await consumer.disconnect();
      this.options.logger.info("kafka consumer stopped", {
        group: this.options.groupId,
      });
    } catch (error) {
      this.options.logger.warn("kafka consumer disconnect failed", {
        group: this.options.groupId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handles a single Kafka message: decode, validate, deduplicate, apply.
   * Exposed for tests; malformed or unsupported messages are logged and skipped
   * so a poison message cannot stall the partition.
   */
  async handleMessage(message: KafkaMessageLike): Promise<void> {
    if (!message.value) {
      return;
    }

    const raw = decodeMessage(message.value);
    const trace = startTrace(headerValue(message.headers, "traceparent"));

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      this.options.logger.warn("discarding community event with invalid JSON", {
        ...traceLogFields(trace),
        offset: message.offset,
      });

      return;
    }

    const envelope = communityEventEnvelopeSchema.safeParse(parsed);

    if (!envelope.success) {
      this.options.logger.warn("discarding community event with invalid envelope", {
        ...traceLogFields(trace),
        offset: message.offset,
      });

      return;
    }

    if (!isSupportedEventType(envelope.data.event_type)) {
      this.options.logger.debug("ignoring unsupported community event", {
        ...traceLogFields(trace),
        event_type: envelope.data.event_type,
      });

      return;
    }

    const event = communityEventSchema.safeParse(envelope.data);

    if (!event.success) {
      this.options.logger.warn("discarding community event with invalid payload", {
        ...traceLogFields(trace),
        event_type: envelope.data.event_type,
        event_id: envelope.data.event_id,
      });

      return;
    }

    if (!this.deduplicator.markIfNew(event.data.event_id)) {
      this.options.logger.debug("skipping duplicate community event", {
        ...traceLogFields(trace),
        event_type: event.data.event_type,
        event_id: event.data.event_id,
      });

      return;
    }

    try {
      await this.options.processor.process(event.data, trace);
    } catch (error) {
      // Handlers are idempotent and moderation must not stall the partition.
      this.options.logger.error("failed to apply community event", {
        ...traceLogFields(trace),
        event_type: event.data.event_type,
        event_id: event.data.event_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordLag(batch: KafkaBatchLike): void {
    const last = batch.messages[batch.messages.length - 1];

    if (!last) {
      return;
    }

    const lag = Number(batch.highWatermark) - (Number(last.offset) + 1);

    this.options.metrics.kafkaConsumerLag.set(
      { topic: batch.topic, group: this.options.groupId },
      lag >= 0 ? lag : 0,
    );
  }
}

function decodeMessage(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function headerValue(
  headers: Record<string, KafkaHeaderValue | undefined> | undefined,
  name: string,
): string | null {
  const header = headers?.[name];

  if (!header?.value) {
    return null;
  }

  return new TextDecoder().decode(header.value);
}

function countAssignedPartitions(payload: unknown): number {
  if (typeof payload !== "object" || payload === null) {
    return 0;
  }

  const assignment = (payload as { memberAssignment?: unknown }).memberAssignment;

  if (typeof assignment !== "object" || assignment === null) {
    return 0;
  }

  return Object.values(assignment as Record<string, unknown>).reduce<number>(
    (total, partitions) =>
      total + (Array.isArray(partitions) ? partitions.length : 0),
    0,
  );
}
