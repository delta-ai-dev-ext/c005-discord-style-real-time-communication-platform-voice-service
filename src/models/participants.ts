import { z } from "zod";

/** A participant entry as returned by `GET .../participants`. */
export const participantSchema = z.object({
  user_id: z.string(),
  is_muted: z.boolean(),
  has_video: z.boolean(),
  joined_at: z.string(),
});

export type Participant = z.infer<typeof participantSchema>;

export const participantListSchema = z.array(participantSchema);
