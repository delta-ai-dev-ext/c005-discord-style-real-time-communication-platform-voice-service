# User Stories: `voice_service`

## Overview
User stories for the voice/video coordination service, derived strictly from the global architecture specification (Section 4.5) and the resolved product decisions for the MVP.

---

## US-001: Join a Voice/Video Room (Token Issuance)
**As a** authenticated member of a community,
**I want to** request a short-lived LiveKit access token for a voice channel,
**So that** I can connect to the WebRTC SFU and start a voice or video session.

### Acceptance Criteria
- [ ] `POST /v1/voice/channels/{channel_id}/token` is called with a valid Clerk JWT.
- [ ] The service synchronously validates the user's access to the channel via `community_service`.
- [ ] If the user has the `can_connect` grant, a LiveKit token is minted with a TTL of ~10 minutes.
- [ ] The participant identity is set to the platform `user_id`.
- [ ] The room name is derived deterministically from the `channel_id`.
- [ ] Grants are mapped correctly:
    - `can_connect` → room join allowed.
    - `can_speak` → microphone publishing.
    - `can_video` → camera/screen publishing.
    - Subscribe is always allowed when connected.
- [ ] Response includes `{server_url, token, room, expires_at, grants: {can_speak, can_video}}`.
- [ ] **Failure Case:** If the caller is banned or lacks membership, the service responds with `403 missing_permission` or `403 banned`.
- [ ] **Failure Case:** If the room is already at its capacity limit (~50 participants), the service responds with `409 room_full`.

## US-002: View Participants of a Voice Channel
**As a** community member,
**I want to** see who is currently in a voice channel,
**So that** I can see which channels are active and who is speaking.

### Acceptance Criteria
- [ ] `GET /v1/voice/channels/{channel_id}/participants` is called with a valid Clerk JWT.
- [ ] The caller must possess the `can_view` permission for the channel (verified via `community_service`).
- [ ] The service queries LiveKit's `RoomServiceClient` to list current participants.
- [ ] The response returns a list of participants with `{user_id, is_muted, has_video, joined_at}`.
- [ ] **Failure Case:** If the caller is not a member or cannot view the channel, the service returns `403 missing_permission`.
- [ ] **Failure Case:** If the underlying LiveKit room does not exist, the service returns an empty list `[]`.

## US-003: Listen-Only Mode for Timed-Out Members
**As a** timed-out community member,
**I want to** remain in a voice room but be unable to publish my microphone or camera,
**So that** I can listen to the ongoing conversation during my timeout.

### Acceptance Criteria
- [ ] When a `member_timed_out` event is consumed from `community_events`, the service calls the LiveKit server API to revoke publish permissions (`canPublish`, `canPublishData`, `canPublishSources`) for that participant.
- [ ] When a `timeout_cleared` event is consumed, the service restores publish permissions based on the current access check.
- [ ] If a timed-out member requests a new token, the response token is strictly **listen-only** (no publish grants).
- [ ] The `voice_moderation_evictions_total{action=timeout}` metric is incremented.

## US-004: Live Moderation Enforcement (Kick/Ban)
**As a** moderator,
**I want to** remove a user from voice rooms immediately when I kick or ban them,
**So that** they cannot remain in the community's voice channels after being removed.

### Acceptance Criteria
- [ ] When a `member_kicked` or `member_banned` event is consumed from `community_events`, the service removes the participant from all of the community's voice rooms listed in the event payload (`voice_channel_ids`).
- [ ] The removal is done via the LiveKit `RoomServiceClient` remove participant endpoint.
- [ ] The enforcement occurs within **5 seconds (p95)** of the action.
- [ ] The `voice_moderation_evictions_total{action=kick|ban}` metric is incremented.

## US-005: Automatic Room Cleanup on Channel Deletion
**As a** community administrator,
**I want to** have all participants removed from a voice room when the channel is deleted,
**So that** no orphaned sessions remain active after the channel is gone.

### Acceptance Criteria
- [ ] When a `channel_deleted` event is consumed from `community_events`, the service removes all participants from that room.
- [ ] The `voice_moderation_evictions_total{action=channel_deleted}` metric is incremented.

## US-006: Voice Session Metrics
**As a** platform operator,
**I want to** track the usage of voice and video sessions,
**So that** we can monitor adoption and scale LiveKit Cloud resources appropriately.

### Acceptance Criteria
- [ ] `POST /v1/webhooks/livekit` is called by LiveKit Cloud for `participant_joined`, `participant_left`, and `room_finished` events.
- [ ] Inbound webhooks are verified via the signed authorization header (JWT + body SHA-256).
- [ ] Unverified or invalid webhooks are rejected with `401`.
- [ ] `voice_participants_joined_total` is incremented on `participant_joined`.
- [ ] `voice_sessions_minutes_total` is updated on `participant_left` or `room_finished`.

## US-007: Health and Readiness Probes
**As a** Kubernetes orchestrator,
**I want to** monitor the state of the service pods,
**So that** traffic is only routed to healthy and fully operational pods.

### Acceptance Criteria
- [ ] `GET /healthz` returns `200` if the service is running.
- [ ] `GET /readyz` returns `200` only if the Kafka consumer has been assigned to partitions.
- [ ] On `SIGTERM`/`SIGINT`, the service drains connections gracefully and stops processing new Kafka events.
