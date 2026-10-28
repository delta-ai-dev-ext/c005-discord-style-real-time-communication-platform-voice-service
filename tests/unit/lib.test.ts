import { afterEach, describe, expect, it } from "bun:test";
import { fetchWithRetry, UpstreamTimeoutError } from "../../src/lib/http.ts";
import { channelIdFromRoomName, roomNameForChannel } from "../../src/lib/room.ts";
import { parseTraceparent, startTrace, traceLogFields } from "../../src/lib/trace.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("trace propagation", () => {
  it("parses a valid traceparent", () => {
    const parsed = parseTraceparent(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );

    expect(parsed).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
      flags: "01",
    });
  });

  it("rejects malformed and all-zero traceparents", () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent("garbage")).toBeNull();
    expect(
      parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"),
    ).toBeNull();
    expect(
      parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"),
    ).toBeNull();
  });

  it("continues an inbound trace with a new span", () => {
    const trace = startTrace(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );

    expect(trace.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(trace.parentSpanId).toBe("00f067aa0ba902b7");
    expect(trace.spanId).not.toBe("00f067aa0ba902b7");
    expect(trace.traceparent).toBe(
      `00-4bf92f3577b34da6a3ce929d0e0e4736-${trace.spanId}-01`,
    );
  });

  it("starts a fresh trace when no header is supplied", () => {
    const trace = startTrace(null);

    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(trace.parentSpanId).toBeUndefined();
    expect(trace.traceparent).toBe(`00-${trace.traceId}-${trace.spanId}-01`);
    expect(traceLogFields(trace)).toEqual({
      trace_id: trace.traceId,
      span_id: trace.spanId,
    });
  });
});

describe("room naming", () => {
  it("derives a deterministic room name from the channel id", () => {
    expect(roomNameForChannel("channel-1")).toBe("voice_channel-1");
    expect(roomNameForChannel("channel-1")).toBe(roomNameForChannel("channel-1"));
  });

  it("round-trips channel ids", () => {
    const derived = channelIdFromRoomName(roomNameForChannel("abc"));

    expect(derived).not.toBeNull();
    expect(String(derived)).toBe("abc");
  });

  it("rejects rooms that are not voice rooms", () => {
    expect(channelIdFromRoomName("lobby")).toBeNull();
    expect(channelIdFromRoomName("voice_")).toBeNull();
  });
});

describe("fetchWithRetry", () => {
  it("returns the first successful response", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;

      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry(
      "http://community.test/access",
      { method: "GET" },
      { timeoutMs: 50, retries: 1 },
    );

    expect(response.status).toBe(200);
    expect(attempts).toBe(1);
  });

  it("retries once on a 5xx response", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;

      return attempts === 1
        ? new Response("boom", { status: 503 })
        : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry(
      "http://community.test/access",
      { method: "GET" },
      { timeoutMs: 50, retries: 1 },
    );

    expect(attempts).toBe(2);
    expect(response.status).toBe(200);
  });

  it("returns the last 5xx response when retries are exhausted", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;

      return new Response("boom", { status: 502 });
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry(
      "http://community.test/access",
      { method: "GET" },
      { timeoutMs: 50, retries: 1 },
    );

    expect(attempts).toBe(2);
    expect(response.status).toBe(502);
  });

  it("does not retry 4xx responses", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;

      return new Response("nope", { status: 403 });
    }) as unknown as typeof fetch;

    const response = await fetchWithRetry(
      "http://community.test/access",
      { method: "GET" },
      { timeoutMs: 50, retries: 1 },
    );

    expect(attempts).toBe(1);
    expect(response.status).toBe(403);
  });

  it("wraps transport failures after exhausting retries", async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    await expect(
      fetchWithRetry(
        "http://community.test/access",
        { method: "GET" },
        { timeoutMs: 50, retries: 1 },
      ),
    ).rejects.toBeInstanceOf(UpstreamTimeoutError);

    expect(attempts).toBe(2);
  });
});
