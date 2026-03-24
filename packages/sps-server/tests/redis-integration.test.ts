import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { __resetJwksCacheForTests } from "../src/middleware/auth.js";
import { createRedisClient, RedisRequestStore } from "../src/services/redis.js";
import { createGatewayAuthFixture, type GatewayAuthFixture } from "./gateway-auth.fixture.js";

const runIntegration = process.env.SPS_REDIS_INTEGRATION === "1";
const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration("redis integration", () => {
  let authFixture: GatewayAuthFixture | null = null;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalProviders = process.env.SPS_AGENT_AUTH_PROVIDERS_JSON;

  beforeAll(async () => {
    if (!process.env.REDIS_URL) {
      throw new Error("REDIS_URL must be set for integration tests");
    }

    process.env.NODE_ENV = "integration";
    authFixture = await createGatewayAuthFixture();
    process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = JSON.stringify([
      { name: "legacy-gateway", jwks_file: authFixture.jwksPath, issuer: "gateway", audience: "sps" }
    ]);
    __resetJwksCacheForTests();
  });

  afterAll(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = originalProviders;
    __resetJwksCacheForTests();
    if (authFixture) {
      await authFixture.cleanup();
    }
  });

  it("runs request -> submit -> retrieve against real Redis", async () => {
    const app = await buildApp({
      hmacSecret: "integration-hmac-secret",
      baseUrl: "http://localhost:3100"
    });

    const jwt = await authFixture!.issueToken({ agentId: "integration-agent" });

    const created = await app.inject({
      method: "POST",
      url: "/api/v2/secret/request",
      headers: {
        authorization: `Bearer ${jwt}`
      },
      payload: {
        public_key: "cHVi",
        description: "Integration secret request"
      }
    });

    expect(created.statusCode).toBe(201);
    const createdPayload = created.json() as { request_id: string; secret_url: string };

    const url = new URL(createdPayload.secret_url);
    const metadataSig = url.searchParams.get("metadata_sig");
    const submitSig = url.searchParams.get("submit_sig");
    expect(metadataSig).toBeTruthy();
    expect(submitSig).toBeTruthy();

    const submit = await app.inject({
      method: "POST",
      url: `/api/v2/secret/submit/${createdPayload.request_id}?sig=${encodeURIComponent(String(submitSig))}`,
      payload: {
        enc: "ZW5j",
        ciphertext: "Y2lwaGVy"
      }
    });

    expect(submit.statusCode).toBe(201);

    const retrieve = await app.inject({
      method: "GET",
      url: `/api/v2/secret/retrieve/${createdPayload.request_id}`,
      headers: {
        authorization: `Bearer ${jwt}`
      }
    });

    expect(retrieve.statusCode).toBe(200);
    expect(retrieve.json()).toEqual({ enc: "ZW5j", ciphertext: "Y2lwaGVy" });

    const secondRetrieve = await app.inject({
      method: "GET",
      url: `/api/v2/secret/retrieve/${createdPayload.request_id}`,
      headers: {
        authorization: `Bearer ${jwt}`
      }
    });

    expect(secondRetrieve.statusCode).toBe(410);

    await app.close();
  });

  it("atomically rejects stale request and approval transitions in Redis", async () => {
    const redis = createRedisClient();
    await redis.connect();

    try {
      const store = new RedisRequestStore(redis);
      const requestId = `redis-request-${Date.now()}`;
      const approvalReference = `redis-approval-${Date.now()}`;

      await store.setRequest({
        requestId,
        requesterId: "agent-1",
        workspaceId: "ws-1",
        publicKey: "cHVi",
        description: "Atomic request transition",
        confirmationCode: "123456",
        status: "pending",
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 60
      }, 60);

      const firstRequestUpdate = await store.updateRequest(requestId, {
        status: "submitted",
        enc: "ZW5j",
        ciphertext: "Y2lwaGVy"
      }, 60, "pending");
      expect(firstRequestUpdate?.status).toBe("submitted");

      const staleRequestUpdate = await store.updateRequest(requestId, {
        ciphertext: "bGF0ZXI="
      }, 60, "pending");
      expect(staleRequestUpdate).toBeNull();
      expect((await store.getRequest(requestId))?.ciphertext).toBe("Y2lwaGVy");

      await store.setApprovalRequest({
        approvalReference,
        requesterId: "agent-1",
        workspaceId: "ws-1",
        secretName: "stripe.api_key.prod",
        purpose: "Atomic approval transition",
        fulfillerHint: "agent:approver",
        ruleId: "rule-1",
        reason: "policy",
        approverIds: ["approver-1"],
        approverRings: ["ops"],
        status: "pending",
        createdAt: Math.floor(Date.now() / 1000),
        expiresAt: Math.floor(Date.now() / 1000) + 60
      }, 60);

      const firstApprovalUpdate = await store.updateApprovalRequest(approvalReference, {
        status: "approved",
        decidedAt: Math.floor(Date.now() / 1000),
        decidedBy: "approver-1"
      }, 60, "pending");
      expect(firstApprovalUpdate?.status).toBe("approved");

      const staleApprovalUpdate = await store.updateApprovalRequest(approvalReference, {
        status: "rejected",
        decidedAt: Math.floor(Date.now() / 1000),
        decidedBy: "approver-2"
      }, 60, "pending");
      expect(staleApprovalUpdate).toBeNull();
      expect((await store.getApprovalRequest(approvalReference))?.status).toBe("approved");
    } finally {
      await redis.quit();
    }
  });
});
