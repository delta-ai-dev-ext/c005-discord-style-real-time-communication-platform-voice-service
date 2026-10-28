import { describe, expect, it } from "bun:test";
import { ConfigurationError, loadConfig } from "../../src/config.ts";

const baseEnv: Record<string, string> = {
  CLERK_PUBLISHABLE_KEY: "pk_test_123",
  CLERK_SECRET_KEY: "sk_test_123",
  LIVEKIT_URL: "wss://project.livekit.cloud",
  LIVEKIT_API_KEY: "lk_key",
  LIVEKIT_API_SECRET: "lk_secret",
  KAFKA_BROKERS: "broker-1:9092, broker-2:9092",
  COMMUNITY_SERVICE_URL: "https://community.internal/",
  INTERNAL_SERVICE_TOKEN: "internal-token",
};

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const config = loadConfig(baseEnv);

    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("info");
    expect(config.kafka.groupId).toBe("voice_service");
    expect(config.kafka.topic).toBe("community_events");
    expect(config.maxRoomCapacity).toBe(50);
    expect(config.tokenTtlSeconds).toBe(600);
  });

  it("splits, trims and validates the kafka broker list", () => {
    const config = loadConfig(baseEnv);

    expect(config.kafka.brokers).toEqual(["broker-1:9092", "broker-2:9092"]);
  });

  it("normalises the community service base url and its resilience settings", () => {
    const config = loadConfig(baseEnv);

    expect(config.communityService.baseUrl).toBe("https://community.internal");
    expect(config.communityService.timeoutMs).toBe(300);
    expect(config.communityService.retries).toBe(1);
    expect(config.communityService.token).toBe("internal-token");
  });

  it("overrides defaults from the environment", () => {
    const config = loadConfig({
      ...baseEnv,
      PORT: "8080",
      LOG_LEVEL: "debug",
      KAFKA_GROUP_ID: "voice-group",
      MAX_ROOM_CAPACITY: "25",
      TOKEN_TTL_SECONDS: "300",
    });

    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("debug");
    expect(config.kafka.groupId).toBe("voice-group");
    expect(config.maxRoomCapacity).toBe(25);
    expect(config.tokenTtlSeconds).toBe(300);
  });

  it("surfaces CLERK_JWT_KEY when configured", () => {
    const config = loadConfig({ ...baseEnv, CLERK_JWT_KEY: "jwt-key" });

    expect(config.clerk.jwtKey).toBe("jwt-key");
  });

  it("rejects a configuration without required secrets", () => {
    const { LIVEKIT_API_SECRET, ...partial } = baseEnv;

    expect(LIVEKIT_API_SECRET).toBe("lk_secret");
    expect(() => loadConfig(partial)).toThrow(ConfigurationError);
  });

  it("reports every invalid variable in the error", () => {
    try {
      loadConfig({ ...baseEnv, LIVEKIT_URL: "not-a-url", MAX_ROOM_CAPACITY: "0" });
      throw new Error("expected loadConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const configurationError = error as ConfigurationError;
      const message = configurationError.message;

      expect(message).toContain("LIVEKIT_URL");
      expect(message).toContain("MAX_ROOM_CAPACITY");
    }
  });

  it("rejects an empty kafka broker list", () => {
    expect(() => loadConfig({ ...baseEnv, KAFKA_BROKERS: " , " })).toThrow(
      ConfigurationError,
    );
  });
});
