import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  used: number;
  retryAfterSeconds: number;
}

export interface WorkspaceBurstResult {
  throttled: boolean;
  triggerAlert: boolean;
  threshold: number;
  windowUsed: number;
  throttleLimit: number;
  throttleUsed: number;
  retryAfterSeconds: number;
}

export interface RateLimitService {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  consumeWorkspaceBurst(
    key: string,
    threshold: number,
    windowMs: number,
    throttleLimit: number,
    throttleWindowMs: number
  ): Promise<WorkspaceBurstResult>;
}

export class InMemoryRateLimitService implements RateLimitService {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();
  private readonly bursts = new Map<string, number[]>();

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

  async consumeWorkspaceBurst(
    key: string,
    threshold: number,
    windowMs: number,
    throttleLimit: number,
    throttleWindowMs: number
  ): Promise<WorkspaceBurstResult> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const throttleWindowStart = now - throttleWindowMs;
    const current = (this.bursts.get(key) ?? []).filter((timestamp) => timestamp > windowStart);
    current.push(now);
    this.bursts.set(key, current);

    const windowUsed = current.length;
    const throttled = windowUsed > threshold;
    const throttleWindowEntries = current.filter((timestamp) => timestamp > throttleWindowStart);
    const throttleUsed = throttleWindowEntries.length;
    const oldestThrottleEntry = throttleWindowEntries[0] ?? now;

    return {
      throttled: throttled && throttleUsed > throttleLimit,
      triggerAlert: windowUsed === threshold + 1,
      threshold,
      windowUsed,
      throttleLimit,
      throttleUsed,
      retryAfterSeconds: throttled && throttleUsed > throttleLimit
        ? Math.max(1, Math.ceil((oldestThrottleEntry + throttleWindowMs - now) / 1000))
        : 0
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

  async consumeWorkspaceBurst(
    key: string,
    threshold: number,
    windowMs: number,
    throttleLimit: number,
    throttleWindowMs: number
  ): Promise<WorkspaceBurstResult> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const throttleWindowStart = now - throttleWindowMs;
    const member = `${now}:${Math.random().toString(16).slice(2)}`;

    await this.redis.zremrangebyscore(key, "-inf", String(windowStart));
    await this.redis.zadd(key, now, member);
    await this.redis.pexpire(key, windowMs);

    const windowUsed = await this.redis.zcard(key);
    const throttled = windowUsed > threshold;

    if (!throttled) {
      return {
        throttled: false,
        triggerAlert: false,
        threshold,
        windowUsed,
        throttleLimit,
        throttleUsed: 0,
        retryAfterSeconds: 0
      };
    }

    const throttleUsed = await this.redis.zcount(key, String(throttleWindowStart), "+inf");
    if (throttleUsed <= throttleLimit) {
      return {
        throttled: false,
        triggerAlert: windowUsed === threshold + 1,
        threshold,
        windowUsed,
        throttleLimit,
        throttleUsed,
        retryAfterSeconds: 0
      };
    }

    const oldestThrottleEntry = await this.redis.zrangebyscore(
      key,
      String(throttleWindowStart),
      "+inf",
      "WITHSCORES",
      "LIMIT",
      0,
      1
    );
    const oldestThrottleScore = Number.parseInt(oldestThrottleEntry[1] ?? String(now), 10);

    return {
      throttled: true,
      triggerAlert: windowUsed === threshold + 1,
      threshold,
      windowUsed,
      throttleLimit,
      throttleUsed,
      retryAfterSeconds: Math.max(1, Math.ceil((oldestThrottleScore + throttleWindowMs - now) / 1000))
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
