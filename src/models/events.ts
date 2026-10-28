import { z } from "zod";

/**
 * Events published by `community_service` on the `community_events` topic.
 * Every payload is validated at the consumer boundary (untrusted input).
 */

const targetPayload = z.object({
  community_id: z.string().min(1),
  user_id: z.string().min(1),
  /** Voice rooms the subject currently occupies, when known by the publisher. */
  voice_channel_ids: z.array(z.string().min(1)).default([]),
});

const timedOutPayload = targetPayload.extend({
  timed_out_until: z.string().datetime({ offset: true }).nullish(),
});

const channelPayload = z.object({
  community_id: z.string().min(1),
  channel_id: z.string().min(1),
});

const overwritePayload = channelPayload.extend({
  affected_user_ids: z.array(z.string().min(1)).default([]),
});

export const COMMUNITY_EVENT_TYPES = [
  "member_kicked",
  "member_banned",
  "member_timed_out",
  "timeout_cleared",
  "channel_deleted",
  "permission_overwrites_changed",
  "member_roles_changed",
] as const;

export type CommunityEventType = (typeof COMMUNITY_EVENT_TYPES)[number];

export const communityEventSchema = z.discriminatedUnion("event_type", [
  z.object({
    event_id: z.string().min(1),
    event_type: z.literal("member_kicked"),
    occurred_at: z.string().optional(),
    payload: targetPayload,
  }),
  z.object({
    event_id: z.string().min(1),
    event_type: z.literal("member_banned"),
    occurred_at: z.string().optional(),
    payload: targetPayload,
  }),
  z.object({
    event_id: z.string().min(1),
    event_type: z.literal("member_timed_out"),
    occurred_at: z.string().optional(),
    payload: timedOutPayload,
  }),
  z.object({
    event_id: z.string().min(1),
    event_type: z.literal("timeout_cleared"),
    occurred_at: z.string().optional(),
    payload: targetPayload,
  }),
  z.object({
    event_id: z.string().min(1),
    event_type: z.literal("channel_deleted"),
    occurred_at: z.string().optional(),
    payload: channelPayload,
  }),
  z.object({
    event_id: z.string().min(1),
    event_type: z.literal("permission_overwrites_changed"),
    occurred_at: z.string().optional(),
    payload: overwritePayload,
  }),
  z.object({
    event_id: z.string().min(1),
    event_type: z.literal("member_roles_changed"),
    occurred_at: z.string().optional(),
    payload: targetPayload,
  }),
]);

export type CommunityEvent = z.infer<typeof communityEventSchema>;

/** Envelope-only schema used to decide whether a message is ours at all. */
export const communityEventEnvelopeSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string().optional(),
  payload: z.unknown(),
});

export function isSupportedEventType(
  value: string,
): value is CommunityEventType {
  return (COMMUNITY_EVENT_TYPES as readonly string[]).includes(value);
}
