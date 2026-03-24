import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { InMemoryRequestStore } from "../src/services/redis.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalCorsAllowedOrigins = process.env.SPS_CORS_ALLOWED_ORIGINS;
const originalUiBaseUrl = process.env.SPS_UI_BASE_URL;
const originalHmacSecret = process.env.SPS_HMAC_SECRET;

function restoreEnv(key: "NODE_ENV" | "SPS_CORS_ALLOWED_ORIGINS" | "SPS_UI_BASE_URL" | "SPS_HMAC_SECRET", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

describe("CORS origin allowlist", () => {
  afterEach(() => {
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv("SPS_CORS_ALLOWED_ORIGINS", originalCorsAllowedOrigins);
    restoreEnv("SPS_UI_BASE_URL", originalUiBaseUrl);
    restoreEnv("SPS_HMAC_SECRET", originalHmacSecret);
  });

  it("allows configured origins and omits CORS headers for others", async () => {
    process.env.NODE_ENV = "test";

    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      corsAllowedOrigins: ["https://app.example.com", "https://secrets.example.com/path"]
    });

    try {
      const allowed = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: {
          origin: "https://app.example.com"
        }
      });
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example.com");

      const allowedFromUiBaseUrl = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: {
          origin: "https://secrets.example.com"
        }
      });
      expect(allowedFromUiBaseUrl.headers["access-control-allow-origin"]).toBe("https://secrets.example.com");

      const denied = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: {
          origin: "https://evil.example.com"
        }
      });
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("allows loopback origins in non-production for local frontends", async () => {
    process.env.NODE_ENV = "development";

    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac"
    });

    try {
      const allowed = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: {
          origin: "http://localhost:5175"
        }
      });
      expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5175");

      const denied = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: {
          origin: "https://evil.example.com"
        }
      });
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("fails closed in production when no browser origin is configured", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.SPS_CORS_ALLOWED_ORIGINS;
    delete process.env.SPS_UI_BASE_URL;

    await expect(buildApp({
      store: new InMemoryRequestStore(),
      hmacSecret: "test-hmac"
    })).rejects.toThrow("Configure SPS_CORS_ALLOWED_ORIGINS or SPS_UI_BASE_URL before enabling production CORS.");
  });
});
