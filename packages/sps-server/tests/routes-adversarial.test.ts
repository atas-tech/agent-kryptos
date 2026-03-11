import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { __resetJwksCacheForTests } from "../src/middleware/auth.js";
import { createGatewayAuthFixture, type GatewayAuthFixture } from "./gateway-auth.fixture.js";

async function prepareSubmittedRequest(jwt: string) {
  const app = await buildApp({
    useInMemoryStore: true,
    hmacSecret: "test-hmac",
    baseUrl: "http://localhost:3100"
  });

  const createdRes = await app.inject({
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

  const created = createdRes.json() as { request_id: string; secret_url: string };
  const url = new URL(created.secret_url);
  const submitSig = url.searchParams.get("submit_sig");
  const metadataSig = url.searchParams.get("metadata_sig");
  if (!submitSig || !metadataSig) {
    throw new Error("Expected scoped signatures");
  }

  const submitRes = await app.inject({
    method: "POST",
    url: `/api/v2/secret/submit/${created.request_id}?sig=${encodeURIComponent(submitSig)}`,
    payload: {
      enc: "ZW5j",
      ciphertext: "Y2lwaGVy"
    }
  });

  expect(submitRes.statusCode).toBe(201);
  return { app, requestId: created.request_id, metadataSig };
}

describe("routes adversarial", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwksFile = process.env.SPS_GATEWAY_JWKS_FILE;
  const originalJwksUrl = process.env.SPS_GATEWAY_JWKS_URL;
  const originalJwksTtl = process.env.SPS_GATEWAY_JWKS_CACHE_TTL_MS;
  const originalProviders = process.env.SPS_AGENT_AUTH_PROVIDERS_JSON;
  let authFixture: GatewayAuthFixture;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    authFixture = await createGatewayAuthFixture();
    process.env.SPS_GATEWAY_JWKS_FILE = authFixture.jwksPath;
    process.env.SPS_GATEWAY_JWKS_URL = "";
    process.env.SPS_GATEWAY_JWKS_CACHE_TTL_MS = "";
    process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = "";
    __resetJwksCacheForTests();
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.SPS_GATEWAY_JWKS_FILE = originalJwksFile;
    process.env.SPS_GATEWAY_JWKS_URL = originalJwksUrl;
    process.env.SPS_GATEWAY_JWKS_CACHE_TTL_MS = originalJwksTtl;
    process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = originalProviders;
    __resetJwksCacheForTests();
    await authFixture.cleanup();
  });

  it("allows only one successful retrieve in concurrent race", async () => {
    const jwt = await authFixture.issueToken({ agentId: "agent-race" });
    const { app, requestId } = await prepareSubmittedRequest(jwt);

    const [a, b] = await Promise.all([
      app.inject({
        method: "GET",
        url: `/api/v2/secret/retrieve/${requestId}`,
        headers: { authorization: `Bearer ${jwt}` }
      }),
      app.inject({
        method: "GET",
        url: `/api/v2/secret/retrieve/${requestId}`,
        headers: { authorization: `Bearer ${jwt}` }
      })
    ]);

    const codes = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    expect(codes).toEqual([200, 410]);

    await app.close();
  });

  it("rejects oversized payload", async () => {
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      baseUrl: "http://localhost:3100"
    });

    const jwt = await authFixture.issueToken({ agentId: "agent-big" });

    const createdRes = await app.inject({
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

    const created = createdRes.json() as { request_id: string; secret_url: string };
    const submitSig = new URL(created.secret_url).searchParams.get("submit_sig");
    if (!submitSig) {
      throw new Error("Expected submit_sig");
    }

    const huge = "a".repeat(10 * 1024 * 1024);
    const submitRes = await app.inject({
      method: "POST",
      url: `/api/v2/secret/submit/${created.request_id}?sig=${encodeURIComponent(submitSig)}`,
      payload: {
        enc: "ZW5j",
        ciphertext: huge
      }
    });

    expect(submitRes.statusCode).toBe(413);
    await app.close();
  });

  it("rejects tampered exp in signature token", async () => {
    const jwt = await authFixture.issueToken({ agentId: "agent-tamper" });
    const { app, requestId, metadataSig } = await prepareSubmittedRequest(jwt);

    const [exp, hmac] = metadataSig.split(".");
    const tampered = `${Number.parseInt(exp, 10) + 60}.${hmac}`;

    const metadataRes = await app.inject({
      method: "GET",
      url: `/api/v2/secret/metadata/${requestId}?sig=${encodeURIComponent(tampered)}`
    });

    expect(metadataRes.statusCode).toBe(403);
    await app.close();
  });
});
