import type { ChannelAccessClient } from "../clients/communityService.ts";
import type { TraceContext } from "../lib/trace.ts";
import type { ChannelAccess } from "../models/access.ts";

export interface JoinAllowed {
  readonly kind: "allow";
  /** Publish grants after applying timeout restrictions. */
  readonly canSpeak: boolean;
  readonly canVideo: boolean;
  /** True when the member is timed out and receives a listen-only token. */
  readonly listenOnly: boolean;
  readonly timedOutUntil: string | null;
}

export interface AccessDenied {
  readonly kind: "deny";
  readonly code: "banned" | "missing_permission";
}

export type JoinDecision = JoinAllowed | AccessDenied;

/**
 * Pure join decision: `banned` wins over missing membership, and a timed-out
 * member keeps `can_connect` but loses every publish capability (US-003).
 */
export function decideJoinAccess(
  access: ChannelAccess,
  now: number = Date.now(),
): JoinDecision {
  if (access.banned) {
    return { kind: "deny", code: "banned" };
  }

  if (!access.is_member || !access.can_connect) {
    return { kind: "deny", code: "missing_permission" };
  }

  const timedOutUntil = parseTimedOutUntil(access.timed_out_until);

  if (timedOutUntil !== null && timedOutUntil > now) {
    return {
      kind: "allow",
      canSpeak: false,
      canVideo: false,
      listenOnly: true,
      timedOutUntil: new Date(timedOutUntil).toISOString(),
    };
  }

  return {
    kind: "allow",
    canSpeak: access.can_speak,
    canVideo: access.can_video,
    listenOnly: false,
    timedOutUntil: null,
  };
}

/** Pure view decision used by the participants endpoint. */
export function decideViewAccess(access: ChannelAccess): AccessDenied | { kind: "allow" } {
  if (access.banned) {
    return { kind: "deny", code: "banned" };
  }

  if (!access.can_view) {
    return { kind: "deny", code: "missing_permission" };
  }

  return { kind: "allow" };
}

export function parseTimedOutUntil(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Reads channel access from `community_service` (the only source of truth for
 * authorization). Decisions are made by the pure helpers above.
 */
export class AuthorizationService {
  constructor(private readonly client: ChannelAccessClient) {}

  getChannelAccess(
    channelId: string,
    userId: string,
    trace: TraceContext,
  ): Promise<ChannelAccess> {
    return this.client.getChannelAccess({ channelId, userId, trace });
  }
}
