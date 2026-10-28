# Engineering Guide: `voice_service`

## Runtime & Toolchain
- **Runtime:** Bun (TypeScript) — strictly no NodeJS.
- **Language:** TypeScript (`strict: true`).
- **Package Manager:** Bun.
- **Build/Test Entrypoints (`Makefile`):**
    - `make dev` — `bun --watch src/index.ts`
    - `make test` — `bun test --coverage`
    - `make run` — `bun run src/index.ts`
    - `make lint` — `bun x eslint src/ tests/`
    - `make build` — `docker build -t $(SERVICE_NAME):latest .`

## Libraries & External Provider SDKs
| Technical Concern | Package / Library | Source | Usage Notes |
|---|---|---|---|
| Runtime | `bun` | language-skill | Mandatory. Never use NodeJS. |
| REST API framework | `elysia` | language-skill | Bun-native HTTP framework. Expose `/healthz` and `/readyz`. |
| Data validation | `zod` | language-skill | Runtime validation for inbound webhooks, access responses, and environment variables. |
| LiveKit SDK | `livekit-server-sdk` | tech-lead-research | Official SDK (v2.x). Use `AccessToken` for token minting, `RoomServiceClient` for participant queries/moderation, `WebhookReceiver` for webhook verification. |
| Clerk JWT verification | `@clerk/backend` | tech-lead-research | Official SDK. Use `verifyToken` / `authenticateRequest` for Clerk JWT verification. |
| Kafka client | `kafkajs` | language-skill | Kafka consumer for `community_events` (consumer group `voice_service`). |
| Logging | `winston` | language-skill | Structured JSON logging. Never use `console.log`. |
| Metrics | `prom-client` | language-skill | Prometheus metrics (`/metrics` endpoint). |
| Testing | `bun:test` | language-skill | Native Bun test runner. `mock()` from `bun:test` for stubbing. |
| HTTP client | `fetch` (native Bun) | language-skill | Standard Web API. No external HTTP client dependency. |

## Container Lifecycle & Probes
- **Statelessness:** The service is fully stateless. Live room state is owned by LiveKit. No PostgreSQL is used.
- **SIGTERM / SIGINT Graceful Shutdown:** On termination, stop consuming from Kafka, wait for in-flight HTTP requests to complete, and exit gracefully.
- **`/healthz` (Liveness):** Returns `200` if the service is running.
- **`/readyz` (Readiness):** Returns `200` only if the Kafka consumer has been assigned to partitions (`consumer.isRunning()` and assignment size > 0). Prevents routing traffic to pods that have not yet attached to the consumer group.

## Testing Strategy
- **Unit Testing:** Tests for token minting, grant mapping, and access decision logic. Use `bun:test`.
- **Integration Testing:** Test HTTP endpoints using the Elysia test adapter. Mock LiveKit's `RoomServiceClient` and `community_service` using `mock()` from `bun:test`.
- **Kafka Testing:** Test Kafka consumer logic by mocking `kafkajs` payloads and asserting that LiveKit `RoomServiceClient` methods are called.
- **Webhook Testing:** Test LiveKit webhook validation with signed JWTs (correct signature) and invalid payloads (should reject with `401`).
- **Determinism:** Ensure tests are parallelized and independent. Use dependency injection (factories) to isolate internal state.

## Coding Conventions & Project Structure
```
src/
├── index.ts              # Elysia app factory and server start
├── routes/               # Elysia routers (voice, webhooks, probes)
├── controllers/          # Request handling (thin, delegates to services)
├── services/             # Business logic (TokenService, RoomService, AuthorizationService)
├── consumers/            # Kafka event consumers (community_events)
├── clients/              # External client adapters (LiveKit, Clerk, CommunityService, Kafka)
├── models/               # Zod schemas and TypeScript types
└── config.ts             # Config loader (env vars via Zod)
tests/
├── unit/
├── integration/
└── mocks/
```
- **Typing:** TypeScript strict mode is mandatory. Branded types for identifiers (e.g. `ChannelId`, `UserId`).
- **Error Handling:** Structured errors `{ error: { code, message, details? } }` with stable machine-readable codes.
- **Validation:** Use `zod` at boundaries. Treat all external service responses (LiveKit, Clerk, community_service) as untrusted.

## Configuration & Secrets Management
12-factor environment variables validated at startup with Zod:
- `PORT` — Server port (default `3000`).
- `LOG_LEVEL` — Logging level (default `info`).
- `CLERK_PUBLISHABLE_KEY` — Clerk publishable key.
- `CLERK_SECRET_KEY` — Clerk secret key.
- `CLERK_JWT_KEY` — Clerk JWKS public key for offline verification.
- `LIVEKIT_URL` — LiveKit Cloud WebSocket URL.
- `LIVEKIT_API_KEY` — LiveKit API key.
- `LIVEKIT_API_SECRET` — LiveKit API secret (for token signing and webhook verification).
- `KAFKA_BROKERS` — Comma-separated list of Kafka brokers.
- `KAFKA_GROUP_ID` — Consumer group (default `voice_service`).
- `COMMUNITY_SERVICE_URL` — Base URL for `community_service` internal API.
- `INTERNAL_SERVICE_TOKEN` — Shared bearer token for internal service calls.
- `MAX_ROOM_CAPACITY` — Maximum participants in a room (default `50`).
- `TOKEN_TTL_SECONDS` — Token lifetime (default `600` seconds / 10 minutes).

## Observability & Logging Conventions
- **Structured Logging:** JSON log fields: `timestamp`, `level`, `service: voice_service`, `trace_id`, `span_id`, `route`, `method`, `status_code`, `event_type`.
- **Trace Propagation:** W3C `traceparent` on all outbound HTTP calls to `community_service` and LiveKit. Propagate `trace_parent` in Kafka message headers.
- **Prometheus Metric Registration:** Register all counters (`voice_*`) and histograms (`voice_livekit_api_duration_seconds`, `http_request_duration_seconds`) at startup.
- **Cardinality:** Metric labels are low-cardinality only (never `user_id`, `community_id`, `channel_id`).

## Pinned Decisions
| Dependency / Area | Pin / Constraint | Rationale | Added By | Date |
|---|---|---|---|---|
| Runtime | `bun` (exclusively) | Mandated stateless container model + TypeScript event-loop performance. | Tech Lead | 2026-06-03 |
| Web Framework | `elysia` | Bun-native, TypeScript-first, highest performance. | Tech Lead | 2026-06-03 |
| LiveKit SDK | `livekit-server-sdk` | Official SDK for tokens, room API, webhooks. | Tech Lead | 2026-06-03 |
| Clerk SDK | `@clerk/backend` | Official Clerk SDK for JWT verification. | Tech Lead | 2026-06-03 |
| Kafka Client | `kafkajs` | Standard TypeScript Kafka client. | Tech Lead | 2026-06-03 |
| Media Transport | LiveKit Cloud (external) | Avoid stateful in-house SFU; fully stateless backend. | Tech Lead | 2026-06-03 |
