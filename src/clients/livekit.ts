import {
  AccessToken,
  RoomServiceClient,
  type ParticipantInfo,
  type VideoGrant,
} from "livekit-server-sdk";
import type { Logger } from "../logger.ts";
import type { Metrics } from "../metrics.ts";

/**
 * LiveKit track sources are re-exported from the SDK's protocol package so the
 * domain layer never depends on protobuf details directly.
 */
export { TrackSource } from "livekit-server-sdk";

export interface RoomParticipantTrack {
  readonly source: number;
  readonly muted: boolean;
}

/** Transport-neutral view of a LiveKit participant. */
export interface RoomParticipant {
  readonly identity: string;
  readonly name?: string;
  readonly joinedAtMs: number;
  readonly tracks: RoomParticipantTrack[];
}

export interface ParticipantPermissionPatch {
  readonly canPublish: boolean;
  readonly canPublishSources: number[];
  readonly canPublishData: boolean;
  readonly canSubscribe: boolean;
}

/**
 * Subset of `RoomServiceClient` used by the service. Declared as an interface so
 * tests can substitute a mock without touching the network.
 */
export interface LiveKitRoomClient {
  listParticipants(room: string): Promise<RoomParticipant[]>;
  listRoomNames(): Promise<string[]>;
  removeParticipant(room: string, identity: string): Promise<void>;
  updateParticipantPermissions(
    room: string,
    identity: string,
    patch: ParticipantPermissionPatch,
  ): Promise<void>;
  deleteRoom(room: string): Promise<void>;
}

export interface MintTokenInput {
  readonly room: string;
  readonly identity: string;
  readonly name?: string;
  readonly ttlSeconds: number;
  readonly grant: VideoGrant;
}

export interface MintedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface TokenMinter {
  mint(input: MintTokenInput): Promise<MintedToken>;
}

/** Locally signs LiveKit access tokens using the API secret (no network call). */
export class LiveKitTokenMinter implements TokenMinter {
  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async mint(input: MintTokenInput): Promise<MintedToken> {
    const accessToken = new AccessToken(this.apiKey, this.apiSecret, {
      identity: input.identity,
      ttl: input.ttlSeconds,
      ...(input.name ? { name: input.name } : {}),
    });

    accessToken.addGrant(input.grant);

    const token = await accessToken.toJwt();

    return {
      token,
      expiresAt: new Date(this.clock() + input.ttlSeconds * 1000),
    };
  }
}

/** Maps the SDK participant protobuf onto the domain view. */
export function toRoomParticipant(participant: ParticipantInfo): RoomParticipant {
  return {
    identity: participant.identity,
    ...(participant.name ? { name: participant.name } : {}),
    joinedAtMs: Number(participant.joinedAtMs ?? participant.joinedAt * 1000n),
    tracks: participant.tracks.map((track) => ({
      source: track.source,
      muted: track.muted,
    })),
  };
}

interface MaybeTwirpError {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

/**
 * LiveKit/Twirp signals "room does not exist" with a `not_found` code. Capacity
 * checks and participant listings must treat that as an empty room rather than
 * a failure (see US-002).
 */
export function isRoomNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as MaybeTwirpError;
  const code =
    typeof candidate.code === "string" ? candidate.code.toLowerCase() : "";
  const status =
    typeof candidate.status === "number" ? candidate.status : undefined;
  const message =
    typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";

  if (code === "not_found") {
    return true;
  }

  if (status === 404) {
    return true;
  }

  return message.includes("not found") || message.includes("does not exist");
}

/**
 * Adapter around the official `RoomServiceClient`. Every call is instrumented so
 * LiveKit latency and failures are visible on `/metrics`.
 */
export class LiveKitRoomService implements LiveKitRoomClient {
  constructor(
    private readonly client: RoomServiceClient,
    private readonly metrics: Pick<
      Metrics,
      "livekitApiDuration" | "livekitApiErrors"
    >,
    private readonly logger: Logger,
  ) {}

  private async instrument<T>(
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const stopTimer = this.metrics.livekitApiDuration.startTimer({ operation });

    try {
      return await run();
    } catch (error) {
      this.metrics.livekitApiErrors.inc({ operation });
      this.logger.warn("livekit api call failed", {
        operation,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    } finally {
      stopTimer();
    }
  }

  async listParticipants(room: string): Promise<RoomParticipant[]> {
    return this.instrument("list_participants", async () => {
      const participants = await this.client.listParticipants(room);

      return participants.map(toRoomParticipant);
    });
  }

  async listRoomNames(): Promise<string[]> {
    return this.instrument("list_rooms", async () => {
      const rooms = await this.client.listRooms();

      return rooms.map((room) => room.name);
    });
  }

  async removeParticipant(room: string, identity: string): Promise<void> {
    await this.instrument("remove_participant", () =>
      this.client.removeParticipant(room, identity),
    );
  }

  async updateParticipantPermissions(
    room: string,
    identity: string,
    patch: ParticipantPermissionPatch,
  ): Promise<void> {
    await this.instrument("update_participant_permissions", () =>
      this.client.updateParticipant(room, identity, {
        permission: {
          canPublish: patch.canPublish,
          canPublishSources: patch.canPublishSources,
          canPublishData: patch.canPublishData,
          canSubscribe: patch.canSubscribe,
        },
      }),
    );
  }

  async deleteRoom(room: string): Promise<void> {
    await this.instrument("delete_room", () => this.client.deleteRoom(room));
  }
}
