import { describe, expect, it } from "bun:test";
import type { ChannelAccess } from "../../src/models/access.ts";
import {
  decideJoinAccess,
  decideViewAccess,
  parseTimedOutUntil,
} from "../../src/services/authorizationService.ts";
import { fullAccess } from "../mocks/index.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function access(overrides: Partial<ChannelAccess> = {}): ChannelAccess {
  return { ...fullAccess("channel-1", "user-1"), ...overrides };
}

describe("decideJoinAccess", () => {
  it("allows a member with can_connect and keeps their publish grants", () => {
    const decision = decideJoinAccess(access(), NOW);

    expect(decision).toEqual({
      kind: "allow",
      canSpeak: true,
      canVideo: true,
      listenOnly: false,
      timedOutUntil: null,
    });
  });

  it("denies banned members even when grants are present", () => {
    expect(decideJoinAccess(access({ banned: true }), NOW)).toEqual({
      kind: "deny",
      code: "banned",
    });
  });

  it("denies non-members", () => {
    expect(decideJoinAccess(access({ is_member: false }), NOW)).toEqual({
      kind: "deny",
      code: "missing_permission",
    });
  });

  it("denies members without can_connect", () => {
    expect(decideJoinAccess(access({ can_connect: false }), NOW)).toEqual({
      kind: "deny",
      code: "missing_permission",
    });
  });

  it("downgrades timed-out members to listen-only", () => {
    const decision = decideJoinAccess(
      access({ timed_out_until: "2026-01-01T12:05:00.000Z" }),
      NOW,
    );

    expect(decision).toEqual({
      kind: "allow",
      canSpeak: false,
      canVideo: false,
      listenOnly: true,
      timedOutUntil: "2026-01-01T12:05:00.000Z",
    });
  });

  it("restores grants once the timeout has elapsed", () => {
    const decision = decideJoinAccess(
      access({ timed_out_until: "2026-01-01T11:55:00.000Z" }),
      NOW,
    );

    expect(decision).toEqual({
      kind: "allow",
      canSpeak: true,
      canVideo: true,
      listenOnly: false,
      timedOutUntil: null,
    });
  });

  it("ignores an unparseable timeout timestamp", () => {
    const decision = decideJoinAccess(access({ timed_out_until: "not-a-date" }), NOW);

    expect(decision.kind).toBe("allow");
    expect(decision.kind === "allow" && decision.listenOnly).toBe(false);
  });

  it("respects per-channel speak/video grants", () => {
    const decision = decideJoinAccess(access({ can_speak: false, can_video: false }), NOW);

    expect(decision).toEqual({
      kind: "allow",
      canSpeak: false,
      canVideo: false,
      listenOnly: false,
      timedOutUntil: null,
    });
  });
});

describe("decideViewAccess", () => {
  it("allows viewers with can_view", () => {
    expect(decideViewAccess(access())).toEqual({ kind: "allow" });
  });

  it("denies callers without can_view", () => {
    expect(decideViewAccess(access({ can_view: false }))).toEqual({
      kind: "deny",
      code: "missing_permission",
    });
  });

  it("reports bans before missing permissions", () => {
    expect(decideViewAccess(access({ can_view: false, banned: true }))).toEqual({
      kind: "deny",
      code: "banned",
    });
  });
});

describe("parseTimedOutUntil", () => {
  it("parses ISO timestamps and ignores empty values", () => {
    expect(parseTimedOutUntil("2026-01-01T12:00:00.000Z")).toBe(NOW);
    expect(parseTimedOutUntil(null)).toBeNull();
    expect(parseTimedOutUntil(undefined)).toBeNull();
    expect(parseTimedOutUntil("nope")).toBeNull();
  });
});
