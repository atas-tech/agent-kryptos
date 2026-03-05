import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { createGatewayAuthFixture, type GatewayAuthFixture } from "./gateway-auth.fixture.js";

async function createRequest(app: Awaited<ReturnType<typeof buildApp>>, jwt: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/secret/request",
    headers: {
      authorization: `Bearer ${jwt}`
    },
    payload: {
      public_key: "cHVi",
      description: "API key"
    }
  });

  expect(response.statusCode).toBe(201);
  return response.json() as { request_id: string; secret_url: string };
}

function queryParam(urlText: string, key: string): string {
  const url = new URL(urlText);
  const value = url.searchParams.get(key);
  if (!value) {
    throw new Error(`Missing query param ${key}`);
  }
  return value;
}

describe("secret routes", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwksFile = process.env.SPS_GATEWAY_JWKS_FILE;
  let authFixture: GatewayAuthFixture;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    authFixture = await createGatewayAuthFixture();
    process.env.SPS_GATEWAY_JWKS_FILE = authFixture.jwksPath;
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.SPS_GATEWAY_JWKS_FILE = originalJwksFile;
    await authFixture.cleanup();
  });

  it("supports request -> metadata -> submit -> retrieve flow", async () => {
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      baseUrl: "http://localhost:3100"
    });

    const jwt = await authFixture.issueToken({ agentId: "agent-route-test" });
    const created = await createRequest(app, jwt);
    const metadataSig = queryParam(created.secret_url, "metadata_sig");
    const submitSig = queryParam(created.secret_url, "submit_sig");

    const metadataRes = await app.inject({
      method: "GET",
      url: `/api/v2/secret/metadata/${created.request_id}?sig=${encodeURIComponent(metadataSig)}`
    });
    expect(metadataRes.statusCode).toBe(200);
    expect(metadataRes.headers["referrer-policy"]).toBe("no-referrer");

    const submitRes = await app.inject({
      method: "POST",
      url: `/api/v2/secret/submit/${created.request_id}?sig=${encodeURIComponent(submitSig)}`,
      payload: {
        enc: "ZW5j",
        ciphertext: "Y2lwaGVy"
      }
    });
    expect(submitRes.statusCode).toBe(201);

    const retrieveRes = await app.inject({
      method: "GET",
      url: `/api/v2/secret/retrieve/${created.request_id}`,
      headers: {
        authorization: `Bearer ${jwt}`
      }
    });

    expect(retrieveRes.statusCode).toBe(200);
    expect(retrieveRes.json()).toEqual({ enc: "ZW5j", ciphertext: "Y2lwaGVy" });

    const secondRetrieve = await app.inject({
      method: "GET",
      url: `/api/v2/secret/retrieve/${created.request_id}`,
      headers: {
        authorization: `Bearer ${jwt}`
      }
    });
    expect(secondRetrieve.statusCode).toBe(410);

    await app.close();
  });

  it("rejects missing gateway auth", async () => {
    const app = await buildApp({ useInMemoryStore: true, hmacSecret: "test-hmac" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/secret/request",
      payload: {
        public_key: "cHVi",
        description: "API key"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    await app.close();
  });

  it("rejects invalid JWT claims", async () => {
    const app = await buildApp({ useInMemoryStore: true, hmacSecret: "test-hmac" });
    const invalidRoleToken = await authFixture.issueToken({
      agentId: "agent-role",
      claims: { role: "not-gateway" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v2/secret/request",
      headers: {
        authorization: `Bearer ${invalidRoleToken}`
      },
      payload: {
        public_key: "cHVi",
        description: "API key"
      }
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("enforces request and submit payload schemas", async () => {
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      baseUrl: "http://localhost:3100"
    });
    const jwt = await authFixture.issueToken({ agentId: "agent-schema" });

    const invalidRequest = await app.inject({
      method: "POST",
      url: "/api/v2/secret/request",
      headers: {
        authorization: `Bearer ${jwt}`
      },
      payload: {
        public_key: "not-base64***",
        description: "API key",
        extra: "should-fail"
      }
    });
    expect(invalidRequest.statusCode).toBe(400);

    const created = await createRequest(app, jwt);
    const submitSig = queryParam(created.secret_url, "submit_sig");

    const invalidSubmit = await app.inject({
      method: "POST",
      url: `/api/v2/secret/submit/${created.request_id}?sig=${encodeURIComponent(submitSig)}`,
      payload: {
        enc: "ZW5j",
        ciphertext: "Y2lwaGVy",
        extra: "should-fail"
      }
    });
    expect(invalidSubmit.statusCode).toBe(400);

    await app.close();
  });

  it("enforces id and sig format in query/path", async () => {
    const app = await buildApp({ useInMemoryStore: true, hmacSecret: "test-hmac" });
    const response = await app.inject({
      method: "GET",
      url: "/api/v2/secret/metadata/not-a-request-id?sig=bad"
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("serves nested UI assets with referrer policy", async () => {
    const app = await buildApp({ useInMemoryStore: true, hmacSecret: "test-hmac" });
    const response = await app.inject({
      method: "GET",
      url: "/ui/vendor/hpke.js"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-type"]).toContain("application/javascript");
    await app.close();
  });

  it("rejects in-memory store in production mode", async () => {
    const originalNodeEnvInner = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";

      await expect(
        buildApp({
          useInMemoryStore: true,
          hmacSecret: "test-hmac"
        })
      ).rejects.toThrow("In-memory store is disabled in production");
    } finally {
      process.env.NODE_ENV = originalNodeEnvInner;
    }
  });
});
