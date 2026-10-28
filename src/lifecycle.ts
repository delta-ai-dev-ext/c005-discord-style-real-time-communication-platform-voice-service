/**
 * Minimal lifecycle contract of the HTTP server, so graceful shutdown can be
 * composed and tested without depending on Elysia's route generics.
 */
export interface StoppableServer {
  stop(closeActiveConnections?: boolean): Promise<unknown>;
}

export interface AppLifecycle {
  /** Stops accepting connections and waits for in-flight requests to finish. */
  stop(): Promise<void>;
}

export function appLifecycle(app: StoppableServer): AppLifecycle {
  return {
    async stop(): Promise<void> {
      await app.stop();
    },
  };
}
