import { z } from "zod";

/**
 * Raised when the process environment cannot be validated at startup.
 * The service must refuse to start rather than run with partial configuration.
 */
export class ConfigurationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid service configuration: ${issues.join("; ")}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

const nonEmpty = (name: string) =>
  z.string().trim().min(1, `${name} is required and must not be empty`);

const optionalNonEmpty = () =>
  z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((value) => (value === "" ? undefined : value));

/**
 * Environment contract for the service (12-factor). Every variable is declared in
 * `docs/engineering_guide.md`; defaults follow that document.
 */
export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),

  CLERK_PUBLISHABLE_KEY: nonEmpty("CLERK_PUBLISHABLE_KEY"),
  CLERK_SECRET_KEY: nonEmpty("CLERK_SECRET_KEY"),
  CLERK_JWT_KEY: optionalNonEmpty(),

  LIVEKIT_URL: z.string().trim().url("LIVEKIT_URL must be a valid URL"),
  LIVEKIT_API_KEY: nonEmpty("LIVEKIT_API_KEY"),
  LIVEKIT_API_SECRET: nonEmpty("LIVEKIT_API_SECRET"),

  KAFKA_BROKERS: z
    .string()
    .trim()
    .min(1, "KAFKA_BROKERS is required")
    .transform((value) =>
      value
        .split(",")
        .map((broker) => broker.trim())
        .filter((broker) => broker.length > 0),
    )
    .refine((brokers) => brokers.length > 0, {
      message: "KAFKA_BROKERS must list at least one broker",
    }),
  KAFKA_GROUP_ID: nonEmpty("KAFKA_GROUP_ID").default("voice_service"),

  COMMUNITY_SERVICE_URL: z
    .string()
    .trim()
    .url("COMMUNITY_SERVICE_URL must be a valid URL"),
  INTERNAL_SERVICE_TOKEN: nonEmpty("INTERNAL_SERVICE_TOKEN"),

  MAX_ROOM_CAPACITY: z.coerce.number().int().positive().max(1000).default(50),
  TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(600),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  readonly port: number;
  readonly logLevel: "error" | "warn" | "info" | "debug";
  readonly clerk: {
    readonly publishableKey: string;
    readonly secretKey: string;
    readonly jwtKey?: string;
  };
  readonly livekit: {
    readonly url: string;
    readonly apiKey: string;
    readonly apiSecret: string;
  };
  readonly kafka: {
    readonly brokers: string[];
    readonly groupId: string;
    readonly topic: string;
    readonly clientId: string;
  };
  readonly communityService: {
    readonly baseUrl: string;
    readonly token: string;
    /** Short timeout mandated by the architecture (300 ms) with one retry. */
    readonly timeoutMs: number;
    readonly retries: number;
  };
  readonly maxRoomCapacity: number;
  readonly tokenTtlSeconds: number;
}

export const COMMUNITY_EVENTS_TOPIC = "community_events";

/**
 * Validates `process.env` (or the supplied record) and maps it onto a typed config.
 * Throws {@link ConfigurationError} listing every offending variable.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "env"}: ${issue.message}`,
    );

    throw new ConfigurationError(issues);
  }

  const value = parsed.data;

  return {
    port: value.PORT,
    logLevel: value.LOG_LEVEL,
    clerk: {
      publishableKey: value.CLERK_PUBLISHABLE_KEY,
      secretKey: value.CLERK_SECRET_KEY,
      jwtKey: value.CLERK_JWT_KEY,
    },
    livekit: {
      url: value.LIVEKIT_URL,
      apiKey: value.LIVEKIT_API_KEY,
      apiSecret: value.LIVEKIT_API_SECRET,
    },
    kafka: {
      brokers: value.KAFKA_BROKERS,
      groupId: value.KAFKA_GROUP_ID,
      topic: COMMUNITY_EVENTS_TOPIC,
      clientId: "voice_service",
    },
    communityService: {
      baseUrl: value.COMMUNITY_SERVICE_URL.replace(/\/$/, ""),
      token: value.INTERNAL_SERVICE_TOKEN,
      timeoutMs: 300,
      retries: 1,
    },
    maxRoomCapacity: value.MAX_ROOM_CAPACITY,
    tokenTtlSeconds: value.TOKEN_TTL_SECONDS,
  };
}
