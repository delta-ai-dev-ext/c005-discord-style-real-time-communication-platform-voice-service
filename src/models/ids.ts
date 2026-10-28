import { z } from "zod";

/**
 * Branded identifiers prevent accidentally passing a user id where a channel id
 * is expected (and vice versa) across service boundaries.
 */
export const channelIdSchema = z
  .string()
  .trim()
  .min(1, "channel_id is required")
  .max(128, "channel_id must be at most 128 characters")
  .regex(
    /^[A-Za-z0-9_.:-]+$/,
    "channel_id may only contain letters, digits, '_', '.', ':' and '-'",
  )
  .brand<"ChannelId">();

export const userIdSchema = z
  .string()
  .trim()
  .min(1, "user_id is required")
  .max(256, "user_id must be at most 256 characters")
  .brand<"UserId">();

export type ChannelId = z.infer<typeof channelIdSchema>;
export type UserId = z.infer<typeof userIdSchema>;

export function toChannelId(value: string): ChannelId {
  return channelIdSchema.parse(value);
}

export function toUserId(value: string): UserId {
  return userIdSchema.parse(value);
}
