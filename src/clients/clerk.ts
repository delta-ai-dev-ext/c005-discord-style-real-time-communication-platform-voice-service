import { verifyToken } from "@clerk/backend";
import type { Logger } from "../logger.ts";
import { isAppError, unauthorized } from "../models/errors.ts";
import { userIdSchema, type UserId } from "../models/ids.ts";

export interface AuthenticatedUser {
  readonly userId: UserId;
  readonly username?: string;
  readonly email?: string;
}

export interface TokenAuthenticator {
  /** Verifies a Clerk session JWT and returns the platform user identity. */
  authenticate(token: string): Promise<AuthenticatedUser>;
}

export interface ClerkOptions {
  readonly secretKey: string;
  readonly jwtKey?: string;
}

interface ClerkClaims {
  sub?: unknown;
  username?: unknown;
  email?: unknown;
  [claim: string]: unknown;
}

/**
 * Verifies Clerk session JWTs. When `CLERK_JWT_KEY` is configured the signature
 * is verified offline against that key; otherwise the SDK resolves the JWKS for
 * the instance from `CLERK_SECRET_KEY`.
 */
export class ClerkTokenAuthenticator implements TokenAuthenticator {
  constructor(
    private readonly options: ClerkOptions,
    private readonly logger: Logger,
  ) {}

  async authenticate(token: string): Promise<AuthenticatedUser> {
    let claims: ClerkClaims;

    try {
      claims = (await verifyToken(
        token,
        this.options.jwtKey
          ? { jwtKey: this.options.jwtKey }
          : { secretKey: this.options.secretKey },
      )) as unknown as ClerkClaims;
    } catch (error) {
      this.logger.warn("clerk token verification failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      throw unauthorized("Invalid or expired Clerk session token");
    }

    if (typeof claims?.sub !== "string" || claims.sub.length === 0) {
      throw unauthorized("Clerk session token is missing a subject claim");
    }

    const parsed = userIdSchema.safeParse(claims.sub);

    if (!parsed.success) {
      throw unauthorized("Clerk session token subject is not a valid user id");
    }

    return {
      userId: parsed.data,
      ...(typeof claims.username === "string" ? { username: claims.username } : {}),
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    };
  }
}

/** Extracts a bearer token from an `Authorization` header. */
export function extractBearerToken(
  authorizationHeader: string | null | undefined,
): string {
  if (!authorizationHeader) {
    throw unauthorized("Missing Authorization header");
  }

  const [scheme, ...rest] = authorizationHeader.trim().split(/\s+/);
  const token = rest.join("");

  if (!scheme || scheme.toLowerCase() !== "bearer" || token.length === 0) {
    throw unauthorized("Authorization header must use a Bearer token");
  }

  return token;
}

export { isAppError };
