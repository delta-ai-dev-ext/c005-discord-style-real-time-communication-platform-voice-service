import winston from "winston";

export const SERVICE_NAME = "voice_service";

export type LogMeta = Record<string, unknown>;

/**
 * Minimal structured logger contract used across the service. The winston
 * implementation satisfies it; tests use in-memory implementations.
 */
export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  child(bindings: LogMeta): Logger;
}

/**
 * Creates the JSON structured logger mandated by the engineering guide.
 * Fields: `timestamp`, `level`, `service`, plus per-call context
 * (`trace_id`, `span_id`, `route`, `method`, `status_code`, `event_type`, ...).
 */
export function createLogger(level: string = "info"): Logger {
  const base = winston.createLogger({
    level,
    defaultMeta: { service: SERVICE_NAME },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json(),
    ),
    transports: [new winston.transports.Console()],
  });

  return toLogger(base);
}

function toLogger(instance: winston.Logger): Logger {
  return {
    debug: (message, meta) => void instance.debug(message, meta),
    info: (message, meta) => void instance.info(message, meta),
    warn: (message, meta) => void instance.warn(message, meta),
    error: (message, meta) => void instance.error(message, meta),
    child: (bindings) => toLogger(instance.child(bindings)),
  };
}
