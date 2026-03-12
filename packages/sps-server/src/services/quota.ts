import type { Redis } from "ioredis";
import type { WorkspaceTier } from "./workspace.js";

export type QuotaAction = "secret_request" | "exchange_request";

export interface QuotaCheckResult {
  allowed: boolean;
  limit: number;
  used: number;
  resetAt: number;
}

export interface QuotaService {
  consumeDailyQuota(workspaceId: string, action: QuotaAction, tier: WorkspaceTier): Promise<QuotaCheckResult>;
}

const DAILY_LIMITS: Record<QuotaAction, Record<WorkspaceTier, number>> = {
  secret_request: {
    free: 10,
    standard: 1_000
  },
  exchange_request: {
    free: 0,
    standard: 1_000
  }
};

const ACTIVE_AGENT_LIMITS: Record<WorkspaceTier, number> = {
  free: 5,
  standard: 50
};

const ACTIVE_MEMBER_LIMITS: Record<WorkspaceTier, number> = {
  free: 1,
  standard: 10
};

function nextUtcMidnightEpochMs(nowMs = Date.now()): number {
  const date = new Date(nowMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function quotaKey(workspaceId: string, action: QuotaAction, nowMs = Date.now()): string {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  return `sps:quota:${workspaceId}:${action}:${date}`;
}

function resolveLimit(action: QuotaAction, tier: WorkspaceTier): number {
  return DAILY_LIMITS[action][tier];
}

function buildQuotaResult(limit: number, used: number, resetAtMs: number): QuotaCheckResult {
  return {
    allowed: used <= limit,
    limit,
    used,
    resetAt: Math.floor(resetAtMs / 1000)
  };
}

export class InMemoryQuotaService implements QuotaService {
  private readonly counters = new Map<string, { count: number; resetAtMs: number }>();

  async consumeDailyQuota(workspaceId: string, action: QuotaAction, tier: WorkspaceTier): Promise<QuotaCheckResult> {
    const limit = resolveLimit(action, tier);
    const nowMs = Date.now();
    const resetAtMs = nextUtcMidnightEpochMs(nowMs);
    const key = quotaKey(workspaceId, action, nowMs);
    const current = this.counters.get(key);

    if (!current || current.resetAtMs <= nowMs) {
      const count = limit === 0 ? 1 : 1;
      this.counters.set(key, { count, resetAtMs });
      return buildQuotaResult(limit, count, resetAtMs);
    }

    current.count += 1;
    this.counters.set(key, current);
    return buildQuotaResult(limit, current.count, current.resetAtMs);
  }
}

export class RedisQuotaService implements QuotaService {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async consumeDailyQuota(workspaceId: string, action: QuotaAction, tier: WorkspaceTier): Promise<QuotaCheckResult> {
    const limit = resolveLimit(action, tier);
    const nowMs = Date.now();
    const resetAtMs = nextUtcMidnightEpochMs(nowMs);
    const key = quotaKey(workspaceId, action, nowMs);
    const ttlSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
    const used = await this.redis.incr(key);
    if (used === 1) {
      await this.redis.expire(key, ttlSeconds);
    }

    return buildQuotaResult(limit, used, resetAtMs);
  }
}

export function activeAgentLimit(tier: WorkspaceTier): number {
  return ACTIVE_AGENT_LIMITS[tier];
}

export function activeMemberLimit(tier: WorkspaceTier): number {
  return ACTIVE_MEMBER_LIMITS[tier];
}

export function exchangeAllowed(tier: WorkspaceTier): boolean {
  return DAILY_LIMITS.exchange_request[tier] > 0;
}
