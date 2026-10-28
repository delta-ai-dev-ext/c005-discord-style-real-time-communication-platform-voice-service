# Architecture: `voice_service`

## 1. Service Responsibilities
`voice_service` is a **stateless coordination and authorization service** for voice/video channels. It is the authoritative bridge between the platform's internal access control (owned by `community_service`) and the external WebRTC media transport (owned by **LiveKit Cloud**).

- **Authorization:** Calls `community_service` synchronously to determine whether a user may join, speak, or publish video.
- **Token Issuance:** Mints short-lived LiveKit access tokens (TTL ~10 min) locally with zero network calls.
- **Moderation Enforcement:** Consumes moderation events from Kafka to remove or mute participants in active rooms.
- **Telemetry:** Receives signed LiveKit webhooks to track voice session metrics.

---

## 2. Internal Component Boundaries
| Component | Responsibility |
|---|---|
| **HTTP Layer** | Exposes public endpoints (token issuance, participant listing) and webhook intake. Validates all inbound Clerk JWTs and LiveKit signatures. |
| **Authorization Service** | Outbound REST client to `community_service` (`GET /internal/v1/channels/{channel_id}/access/{user_id}`). |
| **Token Minter** | Locally generates LiveKit JWTs using the LiveKit API secret. Maps internal access grants to LiveKit grants. |
| **Room Service Adapter** | Outbound client to LiveKit Cloud's `RoomServiceClient` (list participants, remove participants, update permissions). |
| **Kafka Consumer** | Subscribes to `community_events` to apply moderation actions live. |
| **Metrics Collector** | Tracks voice session metrics from webhooks and emits Prometheus counters. |

---

## 3. Request and Event Flows

### 3.1 Join Voice Room Flow (Synchronous HTTP)
1.  Client calls `POST /v1/voice/channels/{channel_id}/token` with a Clerk JWT.
2.  `voice_service` verifies the Clerk JWT offline using Clerk's JWKS.
3.  `voice_service` calls `community_service` `GET /internal/v1/channels/{channel_id}/access/{user_id}` to check access. Short timeout (300ms), 1 retry. Fails closed (`503`) if `community_service` is unavailable.
4.  `voice_service` checks LiveKit's `RoomServiceClient` for current room capacity (~50 participants). If full, return `409 room_full`.
5.  `voice_service` mints a LiveKit token locally with the mapped grants and returns it to the client.
6.  Client connects **directly** to LiveKit Cloud using the token. The backend never relays media.

### 3.2 Moderation Enforcement Flow (Async Kafka)
1.  `community_service` publishes `member_kicked`, `member_banned`, `member_timed_out`, `timeout_cleared`, `channel_deleted`, `permission_overwrites_changed`, or `member_roles_changed` to the `community_events` Kafka topic.
2.  `voice_service` (consumer group `voice_service`) consumes these events.
3.  For `member_kicked` / `member_banned`: `voice_service` calls LiveKit's `RoomServiceClient` to remove the participant from all of the community's voice rooms listed in the event payload (`voice_channel_ids`).
4.  For `member_timed_out`: `voice_service` revokes publish permissions via LiveKit's `RoomServiceClient`.
5.  For `timeout_cleared`: `voice_service` re-evaluates access and restores permissions.
6.  For `channel_deleted`: `voice_service` removes all participants from that room.
7.  For `permission_overwrites_changed` / `member_roles_changed`: `voice_service` re-checks access for affected participants in active rooms.

### 3.3 LiveKit Webhook Flow (Inbound Signed)
1.  LiveKit Cloud pushes events to `POST /v1/webhooks/livekit`.
2.  The service verifies the signed authorization header (JWT + body SHA-256) to ensure authenticity.
3.  The service updates internal metrics (`voice_participants_joined_total`, `voice_sessions_minutes_total`).
4.  Unverified or invalid payloads are rejected with `401`.

---

## 4. Operational Model (Stateless Kubernetes)
- **Statelessness:** Fully stateless. Live room state is owned by LiveKit and queried on demand. No PostgreSQL, no persistent state.
- **Horizontal Scaling:** Since all state is externalized, `voice_service` pods can be scaled independently of each other.
- **Graceful Shutdown:** On `SIGTERM`/`SIGINT`, the service drains connections and stops consuming from Kafka gracefully to allow in-flight moderation events to complete.

---

## 5. Resilience Patterns
- **Idempotency:** Event consumers deduplicate by `event_id`. LiveKit webhook signature verification ensures payload authenticity.
- **Fail Closed:** If `community_service` is unavailable, token issuance fails closed (`503`). No access is granted.
- **Timeouts:** `community_service` internal REST calls have a short timeout (300ms) with 1 retry.

---

## 6. Observability
### Business Metrics
- `voice_tokens_issued_total{grant=full|listen_only}` (Counter)
- `voice_participants_joined_total` (Counter, driven from LiveKit webhooks)
- `voice_sessions_minutes_total` (Counter)
- `voice_room_full_rejections_total` (Counter)
- `voice_moderation_evictions_total{action=kick|ban|timeout|channel_deleted|permission_revoked}` (Counter)

### Performance Metrics
- `http_request_duration_seconds{route, method, status_class}` (Histogram)
- `voice_livekit_api_duration_seconds{operation}` (Histogram)
- `voice_livekit_api_errors_total{operation}` (Counter)
- `kafka_consumer_lag{topic, group}` (Gauge)

### Trace Propagation
W3C `traceparent` is propagated across all HTTP calls and Kafka message headers. Spans are emitted for all outbound LiveKit API calls.

### SLOs
- Token issuance p95 < **200 ms**.
- Moderation eviction applied within **5 s (p95)** of the action.
- Service availability **99.9%**.
