import "server-only";
import { prisma } from "../db";
import { RateLimitedError } from "./errors";
import { recordSecurityEvent } from "./audit";

/**
 * Fixed-window rate limiter backed by Postgres (RateLimitBucket table).
 * Correct and race-safe for a single-instance deployment via an atomic
 * upsert. Sits behind a narrow interface so a Redis-backed sliding-window
 * implementation can replace it for multi-instance production without
 * touching any call site — see docs/production/02-production-architecture.md
 * §5 and docs/production/07-security-architecture.md §6.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

class PostgresRateLimiter implements RateLimiter {
  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = new Date();

    const result = await prisma.$queryRaw<{ count: number; reset_at: Date }[]>`
      INSERT INTO "RateLimitBucket" (key, count, "resetAt")
      VALUES (${key}, 1, ${new Date(now.getTime() + windowSeconds * 1000)})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN "RateLimitBucket"."resetAt" < ${now} THEN 1
          ELSE "RateLimitBucket".count + 1
        END,
        "resetAt" = CASE
          WHEN "RateLimitBucket"."resetAt" < ${now} THEN ${new Date(now.getTime() + windowSeconds * 1000)}
          ELSE "RateLimitBucket"."resetAt"
        END
      RETURNING count, "resetAt" as reset_at;
    `;

    const row = result[0];
    const allowed = row.count <= limit;
    return { allowed, remaining: Math.max(0, limit - row.count), resetAt: row.reset_at };
  }
}

export const rateLimiter: RateLimiter = new PostgresRateLimiter();

/**
 * Convenience wrapper for route handlers: throws RateLimitedError (429) and
 * records a SecurityEvent when the limit is exceeded, so a burst of these
 * is visible to monitoring (docs/production/08-deployment-architecture.md §5)
 * without every call site re-implementing the bookkeeping.
 */
export async function enforceRateLimit(params: {
  key: string;
  limit: number;
  windowSeconds: number;
  ipAddress: string;
  userId?: string | null;
  /** Set by call sites whose `key` embeds the caller's IP (e.g.
   * `register:ip:${ip}`). getClientIp() returns the literal "unknown" for
   * any request it can't attribute to a real address, and every such
   * request would otherwise land in the same bucket — meaning one shared,
   * global limit for every visitor whose IP can't be resolved, not a
   * per-visitor one. Failing open here (skip enforcement, but still
   * counted the pooled key intact) is preferable to blocking unrelated
   * first-time users because of an unresolved header upstream. Leave unset
   * for keys that aren't IP-based (e.g. `mfa:${userId}`), where ipAddress
   * is only along for audit logging and shouldn't affect enforcement. */
  skipIfIpUnknown?: boolean;
}) {
  if (params.skipIfIpUnknown && params.ipAddress === "unknown") {
    return { allowed: true, remaining: params.limit, resetAt: new Date(Date.now() + params.windowSeconds * 1000) };
  }
  const result = await rateLimiter.consume(params.key, params.limit, params.windowSeconds);
  if (!result.allowed) {
    await recordSecurityEvent({
      userId: params.userId ?? null,
      type: "RATE_LIMIT_EXCEEDED",
      ipAddress: params.ipAddress,
      metadata: { key: params.key, limit: params.limit, windowSeconds: params.windowSeconds },
    });
    throw new RateLimitedError();
  }
  return result;
}
