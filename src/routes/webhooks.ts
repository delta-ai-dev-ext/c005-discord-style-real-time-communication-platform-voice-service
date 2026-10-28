import { Elysia } from "elysia";
import type { WebhookController } from "../controllers/webhookController.ts";
import { requestContext } from "../lib/requestContext.ts";

/**
 * Signed LiveKit webhook intake.
 *
 * The route is registered with `parse: "text"` so the handler receives the exact
 * bytes LiveKit signed; the body SHA-256 must match the JWT claim.
 */
export function webhookRoutes(controller: WebhookController) {
  return new Elysia({ name: "webhook-routes" }).post(
    "/v1/webhooks/livekit",
    ({ body, request }) =>
      controller.handle({
        body,
        authorizationHeader:
          request.headers.get("authorization") ?? request.headers.get("authorize"),
        trace: requestContext(request).trace,
      }),
    { parse: "text" },
  );
}
