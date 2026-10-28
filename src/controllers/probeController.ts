export interface ReadinessProbe {
  /** True only when the Kafka consumer is running *and* holds partitions. */
  isReady(): boolean;
}

export interface HealthResponse {
  readonly status: "ok" | "not_ok";
  readonly timestamp: string;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly body: HealthResponse;
}

/**
 * Kubernetes probes. `/healthz` reflects process liveness only; `/readyz` is
 * gated on Kafka consumer assignment so traffic never lands on a pod that has
 * not yet joined the consumer group.
 */
export class ProbeController {
  constructor(
    private readonly readiness: ReadinessProbe,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  live(): ProbeResult {
    return {
      ok: true,
      body: { status: "ok", timestamp: this.clock().toISOString() },
    };
  }

  ready(): ProbeResult {
    const ready = this.readiness.isReady();

    return {
      ok: ready,
      body: {
        status: ready ? "ok" : "not_ok",
        timestamp: this.clock().toISOString(),
      },
    };
  }
}
