import { z } from "zod";

/** Capability pair reported back to the client (and embedded in the token). */
export const voiceGrantsSchema = z.object({
  can_speak: z.boolean(),
  can_video: z.boolean(),
});

export type VoiceGrants = z.infer<typeof voiceGrantsSchema>;

export const tokenResponseSchema = z.object({
  server_url: z.string(),
  token: z.string(),
  room: z.string(),
  expires_at: z.string(),
  grants: voiceGrantsSchema,
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;
