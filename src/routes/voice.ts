import { Elysia } from "elysia";
import type { VoiceController } from "../controllers/voiceController.ts";
import { requestContext } from "../lib/requestContext.ts";

/**
 * Voice token issuance and participant listing.
 *
 * Both endpoints authenticate the caller with a Clerk session JWT and delegate
 * the access decision to `community_service`.
 *
 * The concrete Elysia type is intentionally inferred: Elysia's route generics do
 * not survive an `: Elysia` annotation.
 */
export function voiceRoutes(controller: VoiceController) {
  return new Elysia({ name: "voice-routes" })
    .post("/v1/voice/channels/:channel_id/token", ({ params, request }) =>
      controller.issueToken({
        channelId: params.channel_id,
        authorizationHeader: request.headers.get("authorization"),
        trace: requestContext(request).trace,
      }),
    )
    .get("/v1/voice/channels/:channel_id/participants", ({ params, request }) =>
      controller.listParticipants({
        channelId: params.channel_id,
        authorizationHeader: request.headers.get("authorization"),
        trace: requestContext(request).trace,
      }),
    );
}
