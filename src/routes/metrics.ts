import { Elysia } from "elysia";
import type { Metrics } from "../metrics.ts";

/** Prometheus scrape endpoint. */
export function metricsRoutes(metrics: Metrics) {
  return new Elysia({ name: "metrics-routes" }).get(
    "/metrics",
    async ({ set }) => {
      set.headers["content-type"] = metrics.registry.contentType;

      return metrics.registry.metrics();
    },
  );
}
