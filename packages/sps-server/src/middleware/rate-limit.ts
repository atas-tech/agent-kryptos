import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  used: number;
  retryAfterSeconds: number;
}

export interface RateLimitService {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

export class InMemoryRateLimitService implements RateLimitService {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    const current = this.counts.get(key);

    if (!current || current.resetAt <= now) {
      this.counts.set(key, { count: 1, resetAt: now + windowMs });
      return {
        allowed: true,
        limit,
        used: 1,
        retryAfterSeconds: 0
      };
    }

    if (current.count >= limit) {
      return {
        allowed: false,
        limit,
        used: current.count,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
      };
    }

    current.count += 1;
    this.counts.set(key, current);

    return {
      allowed: true,
      limit,
      used: current.count,
      retryAfterSeconds: 0
    };
  }
}

export class RedisRateLimitService implements RateLimitService {
  constructor(private readonly redis: Redis) {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const used = await this.redis.incr(key);
    if (used === 1) {
      await this.redis.pexpire(key, windowMs);
    }

    if (used > limit) {
      const ttl = await this.redis.pttl(key);
      return {
        allowed: false,
        limit,
        used,
        retryAfterSeconds: Math.max(1, Math.ceil(Math.max(0, ttl) / 1000))
      };
    }

    return {
      allowed: true,
      limit,
      used,
      retryAfterSeconds: 0
    };
  }
}

export function rateLimitKeyByIp(req: FastifyRequest, prefix: string): string {
  return `${prefix}:${req.ip || "unknown"}`;
}

export function sendRateLimited(
  reply: FastifyReply,
  result: RateLimitResult,
  error: string,
  code = "rate_limited"
) {
  reply.header("Retry-After", String(result.retryAfterSeconds));
  return reply.code(429).send({
    error,
    code,
    retry_after_seconds: result.retryAfterSeconds,
    limit: result.limit,
    used: result.used
  });
}
