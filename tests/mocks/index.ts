import { mock } from "bun:test";
import { AccessToken } from "livekit-server-sdk";
import { createApp } from "../../src/app.ts";
import type {
  AuthenticatedUser,
  TokenAuthenticator,
} from "../../src/clients/clerk.ts";
import type { ChannelAccessClient } from "../../src/clients/communityService.ts";
import { LiveKitTokenMinter } from "../../src/clients/livekit.ts";
import type {
  LiveKitRoomClient,
  ParticipantPermissionPatch,
  RoomParticipant,
} from "../../src/clients/livekit.ts";
import { LiveKitWebhookVerifier } from "../../src/clients/webhookVerifier.ts";
import type { AppConfig } from "../../src/config.ts";
import type { Logger, LogMeta } from "../../src/logger.ts";
import { createMetrics, type Metrics } from "../../src/metrics.ts";
import { deniedAccess, type ChannelAccess } from "../../src/models/access.ts";
import { unauthorized } from "../../src/models/errors.ts";
import { toUserId } from "../../src/models/ids.ts";
import { AuthorizationService } from "../../src/services/authorizationService.ts";
import { RoomService } from "../../src/services/roomService.ts";
import { TokenService } from "../../src/services/tokenService.ts";
import { WebhookService } from "../../src/services/webhookService.ts";

export const TEST_LIVEKIT_API_KEY = "test-api-key";
export const TEST_LIVEKIT_API_SECRET = "test-api-secret";
export const TEST_LIVEKIT_URL = "wss://livekit.test";

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    logLevel: "error",
    clerk: { publishableKey: "pk_test", secretKey: "sk_test" },
    livekit: {
      url: TEST_LIVEKIT_URL,
      apiKey: TEST_LIVEKIT_API_KEY,
      apiSecret: TEST_LIVEKIT_API_SECRET,
    },
    kafka: {
      brokers: ["localhost:9092"],
      groupId: "voice_service",
      topic: "community_events",
      clientId: "voice_service",
    },
    communityService: {
      baseUrl: "http://community.test",
      token: "internal-token",
      timeoutMs: 300,
      retries: 1,
    },
    maxRoomCapacity: 50,
    tokenTtlSeconds: 600,
    ...overrides,
  };
}

export interface CapturedLog {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly meta?: LogMeta;
}

export class TestLogger implements Logger {
  readonly entries: CapturedLog[] = [];

  constructor(private readonly bindings: LogMeta = {}) {}

  debug(message: string, meta?: LogMeta): void {
    this.push("debug", message, meta);
  }

  info(message: string, meta?: LogMeta): void {
    this.push("info", message, meta);
  }

  warn(message: string, meta?: LogMeta): void {
    this.push("warn", message, meta);
  }

  error(message: string, meta?: LogMeta): void {
    this.push("error", message, meta);
  }

  child(bindings: LogMeta): Logger {
    const child = new TestLogger({ ...this.bindings, ...bindings });

    return child;
  }

  messages(): string[] {
    return this.entries.map((entry) => entry.message);
  }

  private push(
    level: CapturedLog["level"],
    message: string,
    meta?: LogMeta,
  ): void {
    this.entries.push({
      level,
      message,
      meta: { ...this.bindings, ...(meta ?? {}) },
    });
  }
}

export function createTestLogger(): TestLogger {
  return new TestLogger({ service: "voice_service" });
}

export function createTestMetrics(): Metrics {
  return createMetrics();
}

export function notFoundError(message = "not found"): Error {
  return Object.assign(new Error(message), { code: "not_found" });
}

export function makeParticipant(
  overrides: Partial<RoomParticipant> & { identity: string },
): RoomParticipant {
  return {
    identity: overrides.identity,
    joinedAtMs: overrides.joinedAtMs ?? 1_700_000_000_000,
    tracks: overrides.tracks ?? [],
    ...(overrides.name ? { name: overrides.name } : {}),
  };
}

export interface FakeRoomClient {
  readonly client: LiveKitRoomClient;
  readonly participants: Map<string, RoomParticipant[]>;
  readonly rooms: string[];
  readonly missingRooms: Set<string>;
  readonly permissionUpdates: Array<{
    room: string;
    identity: string;
    patch: ParticipantPermissionPatch;
  }>;
  readonly removedParticipants: Array<{ room: string; identity: string }>;
  readonly deletedRooms: string[];
}

export interface FakeRoomClientOptions {
  readonly participants?: Record<string, RoomParticipant[]>;
  readonly rooms?: string[];
  readonly missingRooms?: string[];
}

/** In-memory stand-in for LiveKit's `RoomServiceClient`. */
export function createFakeRoomClient(
  options: FakeRoomClientOptions = {},
): FakeRoomClient {
  const participants = new Map<string, RoomParticipant[]>(
    Object.entries(options.participants ?? {}),
  );
  const rooms = [...(options.rooms ?? [])];
  const missingRooms = new Set<string>(options.missingRooms ?? []);
  const permissionUpdates: FakeRoomClient["permissionUpdates"] = [];
  const removedParticipants: FakeRoomClient["removedParticipants"] = [];
  const deletedRooms: string[] = [];

  const listParticipants = mock(
    async (room: string): Promise<RoomParticipant[]> => {
      if (missingRooms.has(room)) {
        throw notFoundError("room does not exist");
      }

      return [...(participants.get(room) ?? [])];
    },
  );

  const listRoomNames = mock(async (): Promise<string[]> => [...rooms]);

  const removeParticipant = mock(
    async (room: string, identity: string): Promise<void> => {
      if (missingRooms.has(room)) {
        throw notFoundError("participant does not exist");
      }

      removedParticipants.push({ room, identity });

      const current = participants.get(room) ?? [];
      participants.set(
        room,
        current.filter((participant) => participant.identity !== identity),
      );
    },
  );

  const updateParticipantPermissions = mock(
    async (
      room: string,
      identity: string,
      patch: ParticipantPermissionPatch,
    ): Promise<void> => {
      if (missingRooms.has(room)) {
        throw notFoundError("participant does not exist");
      }

      permissionUpdates.push({ room, identity, patch });
    },
  );

  const deleteRoom = mock(async (room: string): Promise<void> => {
    if (missingRooms.has(room)) {
      throw notFoundError("room does not exist");
    }

    deletedRooms.push(room);
    participants.delete(room);
  });

  return {
    client: {
      listParticipants,
      listRoomNames,
      removeParticipant,
      updateParticipantPermissions,
      deleteRoom,
    },
    participants,
    rooms,
    missingRooms,
    permissionUpdates,
    removedParticipants,
    deletedRooms,
  };
}

export function createTestAuthenticator(
  user: Partial<AuthenticatedUser> = {},
): TokenAuthenticator & { calls: string[] } {
  const calls: string[] = [];

  return {
    calls,
    authenticate: mock(async (token: string): Promise<AuthenticatedUser> => {
      calls.push(token);

      if (token === "invalid-token") {
        throw unauthorized("Invalid or expired Clerk session token");
      }

      return {
        userId: toUserId(user.userId ?? "user-1"),
        ...(user.username ? { username: user.username } : {}),
        ...(user.email ? { email: user.email } : {}),
      };
    }),
  };
}

export function fullAccess(
  channelId: string,
  userId: string,
): ChannelAccess {
  return {
    user_id: userId,
    channel_id: channelId,
    is_member: true,
    banned: false,
    can_connect: true,
    can_speak: true,
    can_video: true,
    can_view: true,
    timed_out_until: null,
  };
}

export function createTestAccessClient(
  access: Partial<ChannelAccess> | ((channelId: string, userId: string) => ChannelAccess) = {},
): ChannelAccessClient & { calls: Array<{ channelId: string; userId: string }> } {
  const calls: Array<{ channelId: string; userId: string }> = [];

  return {
    calls,
    getChannelAccess: mock(
      async ({
        channelId,
        userId,
      }: {
        channelId: string;
        userId: string;
      }): Promise<ChannelAccess> => {
        calls.push({ channelId, userId });

        if (typeof access === "function") {
          return access(channelId, userId);
        }

        return { ...fullAccess(channelId, userId), ...access };
      },
    ),
  };
}

export function createDeniedAccessClient(): ChannelAccessClient {
  return {
    getChannelAccess: mock(
      async ({ channelId, userId }: { channelId: string; userId: string }) =>
        deniedAccess(userId, channelId, "not_member"),
    ),
  };
}

/** Signs a LiveKit webhook exactly like LiveKit Cloud does (JWT + body SHA-256). */
export async function signLiveKitWebhook(
  body: string,
  apiKey: string = TEST_LIVEKIT_API_KEY,
  apiSecret: string = TEST_LIVEKIT_API_SECRET,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  const hash = btoa(
    Array.from(new Uint8Array(digest), (value) => String.fromCharCode(value)).join(
      "",
    ),
  );

  const token = new AccessToken(apiKey, apiSecret, {
    identity: "livekit-webhook",
    ttl: 300,
  });
  token.sha256 = hash;

  return token.toJwt();
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");

  if (!payload) {
    throw new Error("token is not a JWT");
  }

  const normalised = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised.padEnd(
    normalised.length + ((4 - (normalised.length % 4)) % 4),
    "=",
  );

  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

export interface TestAppOptions {
  readonly config?: AppConfig;
  readonly authenticator?: TokenAuthenticator;
  readonly accessClient?: ChannelAccessClient;
  readonly roomClient?: FakeRoomClient;
  readonly ready?: boolean;
  readonly logger?: TestLogger;
  readonly metrics?: Metrics;
}

export interface TestAppHarness {
  readonly app: ReturnType<typeof createApp>;
  readonly config: AppConfig;
  readonly logger: TestLogger;
  readonly metrics: Metrics;
  readonly rooms: RoomService;
  readonly tokens: TokenService;
  readonly webhooks: WebhookService;
  readonly authorization: AuthorizationService;
  readonly authenticator: TokenAuthenticator;
  readonly roomClient: FakeRoomClient;
}

/** Builds the real router/service stack with stubbed external dependencies. */
export function createTestApp(options: TestAppOptions = {}): TestAppHarness {
  const config = options.config ?? createTestConfig();
  const logger = options.logger ?? createTestLogger();
  const metrics = options.metrics ?? createTestMetrics();
  const roomClient = options.roomClient ?? createFakeRoomClient();
  const authenticator =
    options.authenticator ?? createTestAuthenticator();

  const authorization = new AuthorizationService(
    options.accessClient ?? createTestAccessClient(),
  );

  const rooms = new RoomService({
    client: roomClient.client,
    maxRoomCapacity: config.maxRoomCapacity,
    metrics,
    logger,
  });

  const tokens = new TokenService({
    minter: new LiveKitTokenMinter(
      config.livekit.apiKey,
      config.livekit.apiSecret,
    ),
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

  const app = createApp({
    config,
    logger,
    metrics,
    authenticator,
    authorization,
    rooms,
    tokens,
    webhooks,
    readiness: { isReady: () => options.ready ?? true },
  });

  return {
    app,
    config,
    logger,
    metrics,
    rooms,
    tokens,
    webhooks,
    authorization,
    authenticator,
    roomClient,
  };
}

export function jsonRequest(
  path: string,
  init: RequestInit = {},
): Request {
  return new Request(`http://localhost${path}`, init);
}
