import { z } from "zod";

/**
 * Stable, machine-readable error codes exposed by the public API.
 */
export const ERROR_CODES = [
  "missing_permission",
  "banned",
  "room_full",
  "unauthorized",
  "invalid_request",
  "not_found",
  "not_ready",
  "upstream_unavailable",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export const errorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export interface AppErrorOptions {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly cause?: unknown;
}

/**
 * Domain error carrying the HTTP status and machine-readable code that the HTTP
 * layer maps onto the `{ error: { code, message, details? } }` envelope.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "AppError";
    this.status = options.status;
    this.code = options.code;

    if (options.details) {
      this.details = options.details;
    }
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const unauthorized = (message = "Missing or invalid credentials") =>
  new AppError({ status: 401, code: "unauthorized", message });

export const missingPermission = (
  message = "Caller is not permitted to access this voice channel",
) => new AppError({ status: 403, code: "missing_permission", message });

export const banned = (message = "Caller is banned from this community") =>
  new AppError({ status: 403, code: "banned", message });

export const roomFull = (capacity: number) =>
  new AppError({
    status: 409,
    code: "room_full",
    message: "Voice channel is at capacity",
    details: { capacity },
  });

export const notReady = (message = "Service is not ready") =>
  new AppError({ status: 503, code: "not_ready", message });

export const upstreamUnavailable = (
  message = "Access control service is unavailable",
  cause?: unknown,
) =>
  new AppError({
    status: 503,
    code: "upstream_unavailable",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export const invalidRequest = (
  message = "Request failed validation",
  details?: Record<string, unknown>,
) =>
  new AppError({
    status: 400,
    code: "invalid_request",
    message,
    ...(details ? { details } : {}),
  });

export const internalError = (message = "Unexpected error", cause?: unknown) =>
  new AppError({
    status: 500,
    code: "internal_error",
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
