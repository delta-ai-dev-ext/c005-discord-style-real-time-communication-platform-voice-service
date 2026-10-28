import { describe, expect, it } from "bun:test";
import {
  ClerkTokenAuthenticator,
  extractBearerToken,
} from "../../src/clients/clerk.ts";
import { isAppError } from "../../src/models/errors.ts";
import { createTestLogger } from "../mocks/index.ts";

async function expectUnauthorized(run: () => Promise<unknown> | unknown) {
  try {
    await run();
    throw new Error("expected an unauthorized error");
  } catch (error) {
    expect(isAppError(error)).toBe(true);
    expect((error as { status: number }).status).toBe(401);
  }
}

describe("extractBearerToken", () => {
  it("returns the token from a bearer header", () => {
    expect(extractBearerToken("Bearer clerk-session-jwt")).toBe(
      "clerk-session-jwt",
    );
  });

  it("is case-insensitive for the scheme", () => {
    expect(extractBearerToken("bEaReR clerk-session-jwt")).toBe(
      "clerk-session-jwt",
    );
  });

  it("rejects missing and malformed headers", async () => {
    await expectUnauthorized(() => extractBearerToken(undefined));
    await expectUnauthorized(() => extractBearerToken(""));
    await expectUnauthorized(() => extractBearerToken("Basic abc"));
    await expectUnauthorized(() => extractBearerToken("Bearer"));
  });
});

describe("ClerkTokenAuthenticator", () => {
  it("rejects a token that is not a signed JWT", async () => {
    const authenticator = new ClerkTokenAuthenticator(
      { secretKey: "sk_test_123" },
      createTestLogger(),
    );

    await expectUnauthorized(() => authenticator.authenticate("not-a-jwt"));
  });

  it("rejects an unsigned JWT even when a jwt key is configured", async () => {
    const authenticator = new ClerkTokenAuthenticator(
      { secretKey: "sk_test_123", jwtKey: "-----BEGIN PUBLIC KEY-----" },
      createTestLogger(),
    );

    await expectUnauthorized(() =>
      authenticator.authenticate("header.payload.signature"),
    );
  });

  it("logs verification failures without leaking the token", async () => {
    const logger = createTestLogger();
    const authenticator = new ClerkTokenAuthenticator(
      { secretKey: "sk_test_123" },
      logger,
    );

    await expectUnauthorized(() => authenticator.authenticate("not-a-jwt"));

    const entry = logger.entries.find(
      (candidate) => candidate.message === "clerk token verification failed",
    );

    expect(entry).toBeDefined();
    expect(JSON.stringify(entry?.meta)).not.toContain("not-a-jwt");
  });
});
