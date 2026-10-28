import { afterEach, describe, expect, it } from "bun:test";
import { HttpCommunityServiceClient } from "../../src/clients/communityService.ts";
import { startTrace } from "../../src/lib/trace.ts";
import { isAppError } from "../../src/models/errors.ts";
import { createTestLogger } from "../mocks/index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const trace = startTrace(
  "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
);

type FetchInput = Parameters<typeof fetch>[0];

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function stubFetch(
  handler: (call: CapturedCall, attempt: number) => Response | Promise<Response>,
): CapturedCall[] {
  const calls: CapturedCall[] = [];

  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init: init ?? {} });

    return handler({ url, init: init ?? {} }, calls.length);
  }) as unknown as typeof fetch;

  return calls;
}

function createClient() {
  return new HttpCommunityServiceClient(
    {
      baseUrl: "http://community.test",
      token: "internal-token",
      timeoutMs: 50,
      retries: 1,
    },
    createTestLogger(),
  );
}

const validAccessBody = {
  user_id: "user-1",
  channel_id: "channel-1",
  is_member: true,
  banned: false,
  can_connect: true,
  can_speak: true,
  can_video: false,
  can_view: true,
  timed_out_until: null,
};

describe("HttpCommunityServiceClient", () => {
  it("calls the internal access endpoint with bearer auth and trace propagation", async () => {
    const calls = stubFetch(
      () => new Response(JSON.stringify(validAccessBody), { status: 200 }),
    );

    const access = await createClient().getChannelAccess({
      channelId: "channel-1",
      userId: "user-1",
      trace,
    });

    expect(access.can_connect).toBe(true);
    expect(access.can_speak).toBe(true);
    expect(calls[0]?.url).toBe(
      "http://community.test/internal/v1/channels/channel-1/access/user-1",
    );

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer internal-token");
    expect(headers.traceparent).toBe(trace.traceparent);
  });

  it("url-encodes identifiers", async () => {
    const calls = stubFetch(
      () => new Response(JSON.stringify(validAccessBody), { status: 200 }),
    );

    await createClient().getChannelAccess({
      channelId: "chan/1",
      userId: "user 1",
      trace,
    });

    expect(calls[0]?.url).toBe(
      "http://community.test/internal/v1/channels/chan%2F1/access/user%201",
    );
  });

  it("defaults missing grant flags to false", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ user_id: "user-1", channel_id: "channel-1" }),
          { status: 200 },
        ),
    );

    const access = await createClient().getChannelAccess({
      channelId: "channel-1",
      userId: "user-1",
      trace,
    });

    expect(access).toEqual({
      user_id: "user-1",
      channel_id: "channel-1",
      is_member: false,
      banned: false,
      can_connect: false,
      can_speak: false,
      can_video: false,
      can_view: false,
      timed_out_until: null,
    });
  });

  it("maps a banned 403 onto a banned access result", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: "banned" } }), {
          status: 403,
        }),
    );

    const access = await createClient().getChannelAccess({
      channelId: "channel-1",
      userId: "user-1",
      trace,
    });

    expect(access.banned).toBe(true);
    expect(access.is_member).toBe(false);
  });

  it("maps a generic 403 onto missing membership", async () => {
    stubFetch(() => new Response("forbidden", { status: 403 }));

    const access = await createClient().getChannelAccess({
      channelId: "channel-1",
      userId: "user-1",
      trace,
    });

    expect(access.banned).toBe(false);
    expect(access.is_member).toBe(false);
  });

  it("maps 404 onto a non-member result", async () => {
    stubFetch(() => new Response("not found", { status: 404 }));

    const access = await createClient().getChannelAccess({
      channelId: "channel-1",
      userId: "user-1",
      trace,
    });

    expect(access.is_member).toBe(false);
    expect(access.can_connect).toBe(false);
  });

  it("fails closed with 503 after retrying a 5xx response", async () => {
    const calls = stubFetch(() => new Response("boom", { status: 500 }));

    try {
      await createClient().getChannelAccess({
        channelId: "channel-1",
        userId: "user-1",
        trace,
      });
      throw new Error("expected the client to fail closed");
    } catch (error) {
      expect(isAppError(error)).toBe(true);
      expect((error as { status: number }).status).toBe(503);
      expect((error as { code: string }).code).toBe("upstream_unavailable");
    }

    expect(calls).toHaveLength(2);
  });

  it("fails closed when the transport is unavailable", async () => {
    const calls = stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });

    await expect(
      createClient().getChannelAccess({
        channelId: "channel-1",
        userId: "user-1",
        trace,
      }),
    ).rejects.toThrow("Access control service is unavailable");

    expect(calls).toHaveLength(2);
  });

  it("fails closed when the payload is malformed", async () => {
    stubFetch(
      () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    );

    await expect(
      createClient().getChannelAccess({
        channelId: "channel-1",
        userId: "user-1",
        trace,
      }),
    ).rejects.toThrow("invalid response");
  });

  it("fails closed on an unexpected 4xx status", async () => {
    stubFetch(() => new Response("teapot", { status: 418 }));

    await expect(
      createClient().getChannelAccess({
        channelId: "channel-1",
        userId: "user-1",
        trace,
      }),
    ).rejects.toThrow("status 418");
  });
});
