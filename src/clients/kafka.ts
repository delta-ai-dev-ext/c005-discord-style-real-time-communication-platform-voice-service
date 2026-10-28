import { Kafka, logLevel } from "kafkajs";
import type {
  KafkaConsumerFactory,
  KafkaConsumerLike,
} from "../consumers/communityEventsConsumer.ts";

export interface KafkaClientOptions {
  readonly brokers: string[];
  readonly groupId: string;
  readonly clientId: string;
}

/**
 * Builds the `kafkajs` consumer used for `community_events`.
 *
 * The returned factory is injected into the consumer wrapper so tests never
 * touch a real broker.
 */
export function createKafkaConsumerFactory(
  options: KafkaClientOptions,
): KafkaConsumerFactory {
  const kafka = new Kafka({
    clientId: options.clientId,
    brokers: options.brokers,
    logLevel: logLevel.NOTHING,
    retry: { initialRetryTime: 300, retries: 8 },
  });

  return () =>
    kafka.consumer({
      groupId: options.groupId,
      sessionTimeout: 30_000,
      heartbeatInterval: 3_000,
    }) as unknown as KafkaConsumerLike;
}
