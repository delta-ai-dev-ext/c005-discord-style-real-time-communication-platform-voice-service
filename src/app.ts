import { Elysia } from "elysia";
import type { TokenAuthenticator } from "./clients/clerk.ts";
import type { AppConfig } from "./config.ts";
import { ProbeController, type ReadinessProbe } from "./controllers/probeController.ts";
import { VoiceController } from "./controllers/voiceController.ts";
import { WebhookController } from "./controllers/webhookController.ts";
import { attachRequestContext, requestContext } from "./lib/requestContext.ts";
import type { Logger } from "./logger.ts";
import type { Metrics } from "./metrics.ts";
import {
  AppError,
  internalError,
  invalidRequest,
  isAppError,
} from "./models/errors.ts";
import { metricsRoutes } from "./routes/metrics.ts";
import { probeRoutes } from "./routes/probes.ts";
import { voiceRoutes } from "./routes/voice.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import type { AuthorizationService } from "./services/authorizationService.ts";
import type { RoomService } from "./services/roomService.ts";
import type { TokenService } from "./services/tokenService.ts";
import type { WebhookService } from "./services/webhookService.ts";

export interface AppDependencies {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly authenticator: TokenAuthenticator;
  readonly authorization: AuthorizationService;
  readonly rooms: RoomService;
  readonly tokens: TokenService;
  readonly webhooks: WebhookService;
  readonly readiness: ReadinessProbe;
}

/**
 * Composes the HTTP application. Dependencies are injected so integration tests
 * can run the real router stack against stubbed external services.
 *
 * The Elysia instance type is inferred on purpose; an explicit `: Elysia`
 * annotation erases the route generics and fails to typecheck.
 */
export function createApp(deps: AppDependencies) {
  const voiceController = new VoiceController({
    authenticator: deps.authenticator,
    authorization: deps.authorization,
    rooms: deps.rooms,
    tokens: deps.tokens,
    logger: deps.logger,
  });

  const webhookController = new WebhookController({
    webhooks: deps.webhooks,
    logger: deps.logger,
  });

  const probeController = new ProbeController(deps.readiness);

  /**
   * Records the HTTP duration histogram and the structured access log.
   * Invoked from both the success and error paths so every request is counted
   * exactly once with the templated (low-cardinality) route label.
   */
  const recordRequest = (
    request: Request,
    route: string | undefined,
    status: number | string | undefined,
  ): void => {
    const context = requestContext(request);
    const statusCode =
      typeof status === "number" ? status : Number(status) || 200;
    const durationSeconds = (performance.now() - context.startedAt) / 1000;
    const routeLabel = route && route.length > 0 ? route : "unmatched";

    deps.metrics.httpRequestDuration.observe(
      {
        route: routeLabel,
        method: request.method,
        status_class: `${Math.floor(statusCode / 100)}xx`,
      },
      durationSeconds,
    );

    deps.logger.info("http request handled", {
      trace_id: context.trace.traceId,
      span_id: context.trace.spanId,
      route: routeLabel,
      method: request.method,
      status_code: statusCode,
      duration_ms: Math.round(durationSeconds * 1000),
    });
  };

  return new Elysia({ name: "voice_service" })
    .onRequest(({ request }) => {
      attachRequestContext(request);
    })
    .onAfterHandle(({ request, route, set }) => {
      recordRequest(request, route, set.status);
    })
    .onError(({ code, error, request, route, set }) => {
      const context = requestContext(request);

      if (isAppError(error)) {
        set.status = error.status;
        recordRequest(request, route, error.status);

        if (error.status >= 500) {
          deps.logger.error("request failed", {
            trace_id: context.trace.traceId,
            span_id: context.trace.spanId,
            code: error.code,
            status_code: error.status,
            error: error.message,
          });
        }

        return error.toBody();
      }

      if (code === "VALIDATION" || code === "PARSE") {
        set.status = 400;
        recordRequest(request, route, 400);

        return invalidRequest("Request failed validation").toBody();
      }

      if (code === "NOT_FOUND") {
        const notFound = new AppError({
          status: 404,
          code: "not_found",
          message: "Route not found",
        });
        set.status = notFound.status;
        recordRequest(request, route, notFound.status);

        return notFound.toBody();
      }

      const failure = internalError();
      set.status = failure.status;
      recordRequest(request, route, failure.status);

      deps.logger.error("unhandled request error", {
        trace_id: context.trace.traceId,
        span_id: context.trace.spanId,
        status_code: failure.status,
        error: error instanceof Error ? error.message : String(error),
      });

      return failure.toBody();
    })
    .use(metricsRoutes(deps.metrics))
    .use(probeRoutes(probeController))
    .use(voiceRoutes(voiceController))
    .use(webhookRoutes(webhookController));
}
