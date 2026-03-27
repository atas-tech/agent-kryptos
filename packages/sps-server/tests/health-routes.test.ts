import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.js";

function createMockPool(queryImpl?: () => Promise<unknown>): Pool {
  return {
    query: vi.fn(queryImpl ?? (() => Promise.resolve({ rows: [{ value: 1 }] })))
  } as unknown as Pool;
}

describe("health routes", () => {
  it("serves /healthz without dependency checks", async () => {
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac"
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/healthz"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("reports ready when configured checks pass", async () => {
    const app = await buildApp({
      db: createMockPool(),
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      readinessChecks: {
        redis: vi.fn(async () => undefined)
      }
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/readyz"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        checks: {
          database: "up",
          redis: "up"
        }
      });
    } finally {
      await app.close();
    }
  });

  it("returns 503 when the database readiness check fails", async () => {
    const app = await buildApp({
      db: createMockPool(),
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      readinessChecks: {
        db: vi.fn(async () => {
          throw new Error("db unavailable");
        })
      }
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/readyz"
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        ok: false,
        code: "service_unavailable",
        checks: {
          database: "down",
          redis: "skipped"
        }
      });
    } finally {
      await app.close();
    }
  });

  it("returns 503 when the redis readiness check fails", async () => {
    const app = await buildApp({
      db: createMockPool(),
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      readinessChecks: {
        redis: vi.fn(async () => {
          throw new Error("redis unavailable");
        })
      }
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/readyz"
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        ok: false,
        code: "service_unavailable",
        checks: {
          database: "up",
          redis: "down"
        }
      });
    } finally {
      await app.close();
    }
  });

  it("makes in-memory mode explicit in readiness responses", async () => {
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac"
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/readyz"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        checks: {
          database: "skipped",
          redis: "skipped"
        }
      });
    } finally {
      await app.close();
    }
  });
});
