import { RoomServiceClient } from "livekit-server-sdk";
import { createApp } from "./app.ts";
import { ClerkTokenAuthenticator } from "./clients/clerk.ts";
import { HttpCommunityServiceClient } from "./clients/communityService.ts";
import { createKafkaConsumerFactory } from "./clients/kafka.ts";
import { LiveKitRoomService, LiveKitTokenMinter } from "./clients/livekit.ts";
import { toLiveKitHttpUrl } from "./clients/livekitUrl.ts";
import { LiveKitWebhookVerifier } from "./clients/webhookVerifier.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import {
  CommunityEventsConsumer,
  type EventProcessor,
} from "./consumers/communityEventsConsumer.ts";
import { appLifecycle } from "./lifecycle.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { AuthorizationService } from "./services/authorizationService.ts";
import { ModerationService } from "./services/moderationService.ts";
import { RoomService } from "./services/roomService.ts";
import { TokenService } from "./services/tokenService.ts";
import { WebhookService } from "./services/webhookService.ts";

export interface ServiceHandle {
  readonly app: ReturnType<typeof createApp>;
  readonly consumer: CommunityEventsConsumer;
  readonly metrics: Metrics;
  readonly logger: Logger;
  /** Stops Kafka consumption, then drains the HTTP server. */
  stop(): Promise<void>;
}

export interface BuildServiceOptions {
  readonly logger?: Logger;
  readonly metrics?: Metrics;
}

/**
 * Wires every adapter, service, route and the Kafka consumer together. Kept
 * separate from `main` so the whole graph can be built in tests with stubs.
 */
export function buildService(
  config: AppConfig,
  options: BuildServiceOptions = {},
): ServiceHandle {
  const logger = options.logger ?? createLogger(config.logLevel);
  const metrics = options.metrics ?? createMetrics();

  const authorization = new AuthorizationService(
    new HttpCommunityServiceClient(config.communityService, logger),
  );

  const roomServiceClient = new RoomServiceClient(
    toLiveKitHttpUrl(config.livekit.url),
    config.livekit.apiKey,
    config.livekit.apiSecret,
  );

  const rooms = new RoomService({
    client: new LiveKitRoomService(roomServiceClient, metrics, logger),
    maxRoomCapacity: config.maxRoomCapacity,
    metrics,
    logger,
  });

  const tokens = new TokenService({
    minter: new LiveKitTokenMinter(config.livekit.apiKey, config.livekit.apiSecret),
    serverUrl: config.livekit.url,
    ttlSeconds: config.tokenTtlSeconds,
    metrics,
    logger,
  });

  const webhooks = new WebhookService({
    verifier: new LiveKitWebhookVerifier(
      config.livekit.apiKey,
      config.livekit.apiSecret,
      logger,
    ),
    metrics,
    logger,
  });

  const moderation = new ModerationService({
    authorization,
    rooms,
    metrics,
    logger,
  });

  const processor: EventProcessor = {
    process: (event, trace) => moderation.apply(event, trace),
  };

  const consumer = new CommunityEventsConsumer({
    topic: config.kafka.topic,
    groupId: config.kafka.groupId,
    createConsumer: createKafkaConsumerFactory(config.kafka),
    processor,
    logger,
    metrics,
  });

  const app = createApp({
    config,
    logger,
    metrics,
    authenticator: new ClerkTokenAuthenticator(
      {
        secretKey: config.clerk.secretKey,
        ...(config.clerk.jwtKey ? { jwtKey: config.clerk.jwtKey } : {}),
      },
      logger,
    ),
    authorization,
    rooms,
    tokens,
    webhooks,
    readiness: consumer,
  });

  const server = appLifecycle(app);

  return {
    app,
    consumer,
    metrics,
    logger,
    stop: async () => {
      await consumer.stop();
      await server.stop();
    },
  };
}

/**
 * Startup entrypoint: config → graph → HTTP listen → signal handlers → Kafka.
 *
 * The HTTP server starts before the consumer joins the group so `/healthz`
 * answers immediately and `/readyz` keeps the pod out of rotation until Kafka
 * assignment succeeds (a broker outage must not prevent probes from working).
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const service = buildService(config);
  const { logger } = service;

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("shutdown signal received", { signal });

    try {
      await service.stop();
      logger.info("graceful shutdown complete", { signal });
      process.exit(0);
    } catch (error) {
      logger.error("graceful shutdown failed", {
        signal,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  service.app.listen(config.port);

  logger.info("voice_service listening", {
    port: config.port,
    livekit_url: config.livekit.url,
    kafka_group: config.kafka.groupId,
  });

  try {
    await service.consumer.start();
  } catch (error) {
    logger.error("kafka consumer failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

if (import.meta.main) {
  await main();
}
