import { z } from "zod";

/**
 * Response of `GET /internal/v1/channels/{channel_id}/access/{user_id}` on
 * `community_service`. Treated as untrusted input and validated on arrival.
 */
export const channelAccessSchema = z.object({
  user_id: z.string().min(1),
  channel_id: z.string().min(1),
  is_member: z.boolean().default(false),
  banned: z.boolean().default(false),
  can_connect: z.boolean().default(false),
  can_speak: z.boolean().default(false),
  can_video: z.boolean().default(false),
  can_view: z.boolean().default(false),
  timed_out_until: z
    .string()
    .datetime({ offset: true })
    .nullish()
    .transform((value) => value ?? null),
});

export type ChannelAccess = z.infer<typeof channelAccessSchema>;

/** A denied lookup result produced from a 403/404 access response. */
export function deniedAccess(
  userId: string,
  channelId: string,
  reason: "banned" | "not_member",
): ChannelAccess {
  return {
    user_id: userId,
    channel_id: channelId,
    is_member: false,
    banned: reason === "banned",
    can_connect: false,
    can_speak: false,
    can_video: false,
    can_view: false,
    timed_out_until: null,
  };
}
