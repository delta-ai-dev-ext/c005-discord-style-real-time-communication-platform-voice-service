# voice_service

Stateless coordination and authorization service for voice/video channels. Media
transport is delegated to **LiveKit Cloud** (see `docs/adr-001.md`); access control
remains owned by `community_service`. The service owns no persistent state: no
PostgreSQL, no object storage. Live room state is queried from LiveKit on demand.

## Responsibilities

| Flow | Trigger | Behaviour |
|---|---|---|
| Token issuance | `POST /v1/voice/channels/{channel_id}/token` | Verifies Clerk JWT, checks access via `community_service`, checks room capacity via LiveKit, mints a short-lived (10 min) LiveKit access token locally. |
| Participant listing | `GET /v1/voice/channels/{channel_id}/participants` | Requires `can_view`, queries LiveKit `RoomServiceClient`. |
| Telemetry | `POST /v1/webhooks/livekit` | Verifies the LiveKit signature (JWT + body SHA-256) and updates session/participation counters. |
| Moderation enforcement | Kafka topic `community_events` | Removes/mutes participants in LiveKit rooms on `member_kicked`, `member_banned`, `member_timed_out`, `timeout_cleared`, `channel_deleted`, `permission_overwrites_changed`, `member_roles_changed`. |
| Probes | `GET /healthz`, `GET /readyz` | Liveness always 200; readiness 200 only once the Kafka consumer holds partition assignments. |

## Stack

Bun + TypeScript (strict), Elysia (HTTP), `livekit-server-sdk`, `@clerk/backend`,
`kafkajs`, `zod`, `winston`, `prom-client`, native `fetch`, `bun:test`.

## Layout

```
src/
├── index.ts            # Elysia app factory + server start + graceful shutdown
├── app.ts              # composed application (routes, error mapping, metrics)
├── config.ts           # Zod-validated environment configuration
├── logger.ts           # winston structured JSON logger
├── metrics.ts          # prom-client registry and voice_* metrics
├── routes/             # Elysia routers (voice, webhooks, probes, metrics)
├── controllers/        # Thin request handlers delegating to services
├── services/           # Token, room, authorization, webhook, moderation logic
├── consumers/          # community_events Kafka consumer + event processor
├── clients/            # LiveKit, Clerk, community_service adapters
├── models/             # Zod schemas, branded ids, error envelope, types
└── lib/                # trace propagation, room naming, retry helpers
tests/{unit,integration,mocks}
```

## Local development

```bash
bun install
make test          # bun test --coverage
make typecheck     # tsc --noEmit
make lint          # eslint src/ tests/
make dev           # bun --watch src/index.ts
```

## Configuration

All configuration is read from the environment and validated with Zod at startup
(`src/config.ts`). Required: `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`,
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `KAFKA_BROKERS`,
`COMMUNITY_SERVICE_URL`, `INTERNAL_SERVICE_TOKEN`. Optional: `PORT` (3000),
`LOG_LEVEL` (info), `CLERK_JWT_KEY`, `KAFKA_GROUP_ID` (voice_service),
`MAX_ROOM_CAPACITY` (50), `TOKEN_TTL_SECONDS` (600).
