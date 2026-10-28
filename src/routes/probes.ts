import { Elysia } from "elysia";
import type { ProbeController } from "../controllers/probeController.ts";

/**
 * Liveness and readiness probes.
 *
 * Probes are served both at the root (standard Kubernetes probe paths) and under
 * `/v1` (the versioned base path documented in `docs/openapi_spec.yaml`).
 */
export function probeRoutes(controller: ProbeController) {
  return new Elysia({ name: "probe-routes" })
    .get("/healthz", ({ set }) => {
      const result = controller.live();
      set.status = result.ok ? 200 : 500;

      return result.body;
    })
    .get("/readyz", ({ set }) => {
      const result = controller.ready();
      set.status = result.ok ? 200 : 503;

      return result.body;
    })
    .get("/v1/healthz", ({ set }) => {
      const result = controller.live();
      set.status = result.ok ? 200 : 500;

      return result.body;
    })
    .get("/v1/readyz", ({ set }) => {
      const result = controller.ready();
      set.status = result.ok ? 200 : 503;

      return result.body;
    });
}
