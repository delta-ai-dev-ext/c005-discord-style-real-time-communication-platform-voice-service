import type { Logger } from "../logger.ts";
import type { TraceContext } from "../lib/trace.ts";
import { unauthorized } from "../models/errors.ts";
import type { WebhookService } from "../services/webhookService.ts";

export interface WebhookControllerOptions {
  readonly webhooks: WebhookService;
  readonly logger: Logger;
}

export interface LiveKitWebhookRequest {
  /** Raw request body: the SHA-256 signature is computed over the exact bytes. */
  readonly body: unknown;
  readonly authorizationHeader: string | null | undefined;
  readonly trace: TraceContext;
}

export interface WebhookAcknowledgement {
  readonly received: true;
  readonly event: string;
}

export class WebhookController {
  constructor(private readonly options: WebhookControllerOptions) {}

  async handle(input: LiveKitWebhookRequest): Promise<WebhookAcknowledgement> {
    const rawBody = normaliseBody(input.body);

    if (rawBody.length === 0) {
      throw unauthorized("LiveKit webhook body is empty");
    }

    const event = await this.options.webhooks.handle(
      rawBody,
      input.authorizationHeader,
      input.trace,
    );

    return { received: true, event: event.event };
  }
}

function normaliseBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }

  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }

  if (body === undefined || body === null) {
    return "";
  }

  return JSON.stringify(body);
}
