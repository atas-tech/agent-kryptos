import { Redis } from "ioredis";
import type { RequestStore, StoredRequest } from "../types.js";

function keyFor(requestId: string): string {
  return `sps:request:${requestId}`;
}

export class RedisRequestStore implements RequestStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async setRequest(data: StoredRequest, ttlSeconds: number): Promise<void> {
    await this.redis.set(keyFor(data.requestId), JSON.stringify(data), "EX", ttlSeconds);
  }

  async getRequest(requestId: string): Promise<StoredRequest | null> {
    const raw = await this.redis.get(keyFor(requestId));
    return raw ? (JSON.parse(raw) as StoredRequest) : null;
  }

  async updateRequest(requestId: string, patch: Partial<StoredRequest>, ttlSeconds?: number): Promise<StoredRequest | null> {
    const current = await this.getRequest(requestId);
    if (!current) {
      return null;
    }

    const next = { ...current, ...patch };
    if (typeof ttlSeconds === "number") {
      await this.redis.set(keyFor(requestId), JSON.stringify(next), "EX", ttlSeconds);
    } else {
      const pttl = await this.redis.pttl(keyFor(requestId));
      if (pttl > 0) {
        await this.redis.set(keyFor(requestId), JSON.stringify(next), "PX", pttl);
      } else {
        await this.redis.set(keyFor(requestId), JSON.stringify(next));
      }
    }

    return next;
  }

  async atomicRetrieveAndDelete(requestId: string): Promise<StoredRequest | null> {
    const script = `
      local key = KEYS[1]
      local data = redis.call('GET', key)
      if data then
        redis.call('DEL', key)
        return data
      else
        return nil
      end
    `;

    const raw = await this.redis.eval(script, 1, keyFor(requestId));
    if (typeof raw !== "string") {
      return null;
    }

    return JSON.parse(raw) as StoredRequest;
  }

  async deleteRequest(requestId: string): Promise<boolean> {
    return (await this.redis.del(keyFor(requestId))) > 0;
  }
}

export class InMemoryRequestStore implements RequestStore {
  private readonly data = new Map<string, StoredRequest>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  async setRequest(data: StoredRequest, ttlSeconds: number): Promise<void> {
    this.data.set(data.requestId, data);
    this.scheduleExpiry(data.requestId, ttlSeconds);
  }

  async getRequest(requestId: string): Promise<StoredRequest | null> {
    return this.data.get(requestId) ?? null;
  }

  async updateRequest(requestId: string, patch: Partial<StoredRequest>, ttlSeconds?: number): Promise<StoredRequest | null> {
    const current = this.data.get(requestId);
    if (!current) {
      return null;
    }

    const next = { ...current, ...patch };
    this.data.set(requestId, next);
    if (typeof ttlSeconds === "number") {
      this.scheduleExpiry(requestId, ttlSeconds);
    }

    return next;
  }

  async atomicRetrieveAndDelete(requestId: string): Promise<StoredRequest | null> {
    const current = this.data.get(requestId);
    if (!current) {
      return null;
    }
    this.clearExpiry(requestId);
    this.data.delete(requestId);
    return current;
  }

  async deleteRequest(requestId: string): Promise<boolean> {
    const existed = this.data.delete(requestId);
    this.clearExpiry(requestId);
    return existed;
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.data.clear();
  }

  private scheduleExpiry(requestId: string, ttlSeconds: number): void {
    this.clearExpiry(requestId);
    const timer = setTimeout(() => {
      this.data.delete(requestId);
      this.timers.delete(requestId);
    }, ttlSeconds * 1000);
    timer.unref();
    this.timers.set(requestId, timer);
  }

  private clearExpiry(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(requestId);
    }
  }
}

export function createRedisClient(url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379"): Redis {
  return new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });
}
