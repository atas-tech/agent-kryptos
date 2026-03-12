import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/index.js";
import { __resetJwksCacheForTests } from "../src/middleware/auth.js";
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
  const originalJwksUrl = process.env.SPS_GATEWAY_JWKS_URL;
  const originalJwksTtl = process.env.SPS_GATEWAY_JWKS_CACHE_TTL_MS;
  const originalRequireSpiffe = process.env.SPS_REQUIRE_SPIFFE;
  const originalAgentIssuers = process.env.SPS_AGENT_JWT_ISSUERS;
  const originalAgentAudiences = process.env.SPS_AGENT_JWT_AUDIENCES;
  const originalProviders = process.env.SPS_AGENT_AUTH_PROVIDERS_JSON;
  const originalHostedMode = process.env.SPS_HOSTED_MODE;
  let authFixture: GatewayAuthFixture;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    authFixture = await createGatewayAuthFixture();
    process.env.SPS_GATEWAY_JWKS_FILE = authFixture.jwksPath;
    process.env.SPS_GATEWAY_JWKS_URL = "";
    process.env.SPS_GATEWAY_JWKS_CACHE_TTL_MS = "";
    process.env.SPS_REQUIRE_SPIFFE = "";
    process.env.SPS_AGENT_JWT_ISSUERS = "";
    process.env.SPS_AGENT_JWT_AUDIENCES = "";
    process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = "";
    process.env.SPS_HOSTED_MODE = "";
    __resetJwksCacheForTests();
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.SPS_GATEWAY_JWKS_FILE = originalJwksFile;
    process.env.SPS_GATEWAY_JWKS_URL = originalJwksUrl;
    process.env.SPS_GATEWAY_JWKS_CACHE_TTL_MS = originalJwksTtl;
    process.env.SPS_REQUIRE_SPIFFE = originalRequireSpiffe;
    process.env.SPS_AGENT_JWT_ISSUERS = originalAgentIssuers;
    process.env.SPS_AGENT_JWT_AUDIENCES = originalAgentAudiences;
    process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = originalProviders;
    process.env.SPS_HOSTED_MODE = originalHostedMode;
    __resetJwksCacheForTests();
    vi.restoreAllMocks();
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

  it("requires workspace_id on workload JWTs in hosted mode", async () => {
    process.env.SPS_HOSTED_MODE = "1";
    const app = await buildApp({ useInMemoryStore: true, hmacSecret: "test-hmac" });
    const jwt = await authFixture.issueToken({ agentId: "agent-hosted-missing" });

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

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "workspace_id claim required in hosted mode" });
    await app.close();
  });

  it("isolates secret retrieval by workspace in hosted mode", async () => {
    process.env.SPS_HOSTED_MODE = "1";
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      baseUrl: "http://localhost:3100"
    });

    const ownerJwt = await authFixture.issueToken({
      agentId: "agent-shared-id",
      claims: { role: "gateway", workspace_id: "ws-alpha" }
    });
    const otherWorkspaceJwt = await authFixture.issueToken({
      agentId: "agent-shared-id",
      claims: { role: "gateway", workspace_id: "ws-beta" }
    });

    const created = await createRequest(app, ownerJwt);
    const submitSig = queryParam(created.secret_url, "submit_sig");

    const submitRes = await app.inject({
      method: "POST",
      url: `/api/v2/secret/submit/${created.request_id}?sig=${encodeURIComponent(submitSig)}`,
      payload: {
        enc: "ZW5j",
        ciphertext: "Y2lwaGVy"
      }
    });
    expect(submitRes.statusCode).toBe(201);

    const wrongWorkspaceRetrieve = await app.inject({
      method: "GET",
      url: `/api/v2/secret/retrieve/${created.request_id}`,
      headers: {
        authorization: `Bearer ${otherWorkspaceJwt}`
      }
    });
    expect(wrongWorkspaceRetrieve.statusCode).toBe(410);

    const ownerRetrieve = await app.inject({
      method: "GET",
      url: `/api/v2/secret/retrieve/${created.request_id}`,
      headers: {
        authorization: `Bearer ${ownerJwt}`
      }
    });
    expect(ownerRetrieve.statusCode).toBe(200);

    await app.close();
  });

  it("accepts SPIFFE workload claims when SPIFFE mode is required", async () => {
    process.env.SPS_REQUIRE_SPIFFE = "1";
    const app = await buildApp({ useInMemoryStore: true, hmacSecret: "test-hmac" });
    const jwt = await authFixture.issueToken({
      agentId: "agent:finance-bot",
      claims: {
        role: "gateway",
        spiffe_id: "spiffe://myorg.local/ring/finance/finance-bot",
        workload_mode: "spiffe-jwt"
      }
    });

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
    await app.close();
  });

  it("rejects non-SPIFFE workload tokens when SPIFFE mode is required", async () => {
    process.env.SPS_REQUIRE_SPIFFE = "true";
    const app = await buildApp({ useInMemoryStore: true, hmacSecret: "test-hmac" });
    const jwt = await authFixture.issueToken({ agentId: "agent:no-spiffe" });

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

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "SPIFFE workload identity required" });
    await app.close();
  });

  it("accepts configured non-default issuer values for workload JWTs", async () => {
    process.env.SPS_AGENT_JWT_ISSUERS = "gateway,spire";
    const app = await buildApp({ useInMemoryStore: true, hmacSecret: "test-hmac" });
    const jwt = await authFixture.issueToken({
      agentId: "agent:spiffe-bot",
      issuer: "spire",
      claims: {
        role: "gateway",
        spiffe_id: "spiffe://myorg.local/ring/ops/deploy-bot",
        workload_mode: "spiffe-jwt"
      }
    });

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
    await app.close();
  });

  it("supports multiple auth providers with distinct JWKS sources", async () => {
    const spireFixture = await createGatewayAuthFixture();
    process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = JSON.stringify([
      {
        name: "gateway-local",
        issuer: "gateway",
        audience: "sps",
        jwks_file: authFixture.jwksPath
      },
      {
        name: "spire-prod",
        issuer: "spire",
        audience: "sps",
        jwks_file: spireFixture.jwksPath,
        require_spiffe: true
      }
    ]);
    process.env.SPS_GATEWAY_JWKS_FILE = "";
    process.env.SPS_AGENT_JWT_ISSUERS = "";
    __resetJwksCacheForTests();

    try {
      const app = await buildApp({ useInMemoryStore: true, hmacSecret: "test-hmac" });
      const jwt = await spireFixture.issueToken({
        agentId: "agent:spire-prod",
        issuer: "spire",
        claims: {
          role: "gateway",
          spiffe_id: "spiffe://myorg.local/ring/ops/deploy-bot",
          workload_mode: "spiffe-jwt"
        }
      });

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
      await app.close();
    } finally {
      await spireFixture.cleanup();
    }
  });

  it("enforces provider-level SPIFFE requirements from auth provider config", async () => {
    const spireFixture = await createGatewayAuthFixture();
    process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = JSON.stringify([
      {
        name: "spire-prod",
        issuer: "spire",
        audience: "sps",
        jwks_file: spireFixture.jwksPath,
        require_spiffe: true
      }
    ]);
    process.env.SPS_GATEWAY_JWKS_FILE = "";
    __resetJwksCacheForTests();

    try {
      const app = await buildApp({ useInMemoryStore: true, hmacSecret: "test-hmac" });
      const jwt = await spireFixture.issueToken({
        agentId: "agent:no-spiffe",
        issuer: "spire",
        claims: { role: "gateway" }
      });

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

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "SPIFFE workload identity required" });
      await app.close();
    } finally {
      await spireFixture.cleanup();
    }
  });

  it("supports gateway auth via SPS_GATEWAY_JWKS_URL with cache reuse", async () => {
    process.env.SPS_GATEWAY_JWKS_FILE = "";
    process.env.SPS_GATEWAY_JWKS_URL = "https://gateway.example/.well-known/jwks.json";
    process.env.SPS_GATEWAY_JWKS_CACHE_TTL_MS = "60000";
    __resetJwksCacheForTests();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(authFixture.jwks), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      baseUrl: "http://localhost:3100"
    });

    const jwt = await authFixture.issueToken({ agentId: "agent-url-jwks" });
    const createdA = await createRequest(app, jwt);
    const createdB = await createRequest(app, jwt);

    expect(createdA.request_id).toHaveLength(64);
    expect(createdB.request_id).toHaveLength(64);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

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
