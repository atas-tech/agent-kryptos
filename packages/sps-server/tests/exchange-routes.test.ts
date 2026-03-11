import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { __resetJwksCacheForTests } from "../src/middleware/auth.js";
import { createGatewayAuthFixture, type GatewayAuthFixture } from "./gateway-auth.fixture.js";

describe("exchange routes", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwksFile = process.env.SPS_GATEWAY_JWKS_FILE;
  const originalJwksUrl = process.env.SPS_GATEWAY_JWKS_URL;
  const originalJwksTtl = process.env.SPS_GATEWAY_JWKS_CACHE_TTL_MS;
  let authFixture: GatewayAuthFixture;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    authFixture = await createGatewayAuthFixture();
    process.env.SPS_GATEWAY_JWKS_FILE = authFixture.jwksPath;
    process.env.SPS_GATEWAY_JWKS_URL = "";
    process.env.SPS_GATEWAY_JWKS_CACHE_TTL_MS = "";
    __resetJwksCacheForTests();
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.SPS_GATEWAY_JWKS_FILE = originalJwksFile;
    process.env.SPS_GATEWAY_JWKS_URL = originalJwksUrl;
    process.env.SPS_GATEWAY_JWKS_CACHE_TTL_MS = originalJwksTtl;
    __resetJwksCacheForTests();
    await authFixture.cleanup();
  });

  it("supports create -> fulfill -> submit -> retrieve flow with ownership binding", async () => {
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      secretRegistry: [
        {
          secretName: "stripe.api_key.prod",
          classification: "credential"
        }
      ],
      exchangePolicyRules: [
        {
          ruleId: "stripe-prod",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:crm-bot"],
          fulfillerIds: ["agent:payment-bot"]
        }
      ]
    });

    const requesterJwt = await authFixture.issueToken({ agentId: "agent:crm-bot" });
    const fulfillerJwt = await authFixture.issueToken({ agentId: "agent:payment-bot" });
    const otherJwt = await authFixture.issueToken({ agentId: "agent:other-bot" });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: {
        authorization: `Bearer ${requesterJwt}`
      },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "agent:payment-bot"
      }
    });

    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as { exchange_id: string; fulfillment_token: string };

    const fulfillRes = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/fulfill",
      headers: {
        authorization: `Bearer ${fulfillerJwt}`
      },
      payload: {
        fulfillment_token: created.fulfillment_token
      }
    });
    expect(fulfillRes.statusCode).toBe(200);
    expect(fulfillRes.json()).toMatchObject({
      exchange_id: created.exchange_id,
      status: "reserved",
      requester_id: "agent:crm-bot",
      fulfilled_by: "agent:payment-bot"
    });

    const secondFulfill = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/fulfill",
      headers: {
        authorization: `Bearer ${fulfillerJwt}`
      },
      payload: {
        fulfillment_token: created.fulfillment_token
      }
    });
    expect(secondFulfill.statusCode).toBe(409);

    const submitRes = await app.inject({
      method: "POST",
      url: `/api/v2/secret/exchange/submit/${created.exchange_id}`,
      headers: {
        authorization: `Bearer ${fulfillerJwt}`
      },
      payload: {
        enc: "ZW5j",
        ciphertext: "Y2lwaGVy"
      }
    });
    expect(submitRes.statusCode).toBe(201);

    const wrongRetrieve = await app.inject({
      method: "GET",
      url: `/api/v2/secret/exchange/retrieve/${created.exchange_id}`,
      headers: {
        authorization: `Bearer ${otherJwt}`
      }
    });
    expect(wrongRetrieve.statusCode).toBe(410);

    const retrieveRes = await app.inject({
      method: "GET",
      url: `/api/v2/secret/exchange/retrieve/${created.exchange_id}`,
      headers: {
        authorization: `Bearer ${requesterJwt}`
      }
    });
    expect(retrieveRes.statusCode).toBe(200);
    expect(retrieveRes.json()).toEqual({
      enc: "ZW5j",
      ciphertext: "Y2lwaGVy",
      secret_name: "stripe.api_key.prod",
      fulfilled_by: "agent:payment-bot"
    });

    await app.close();
  });

  it("returns 403 when policy does not allow the exchange", async () => {
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      secretRegistry: [
        {
          secretName: "stripe.api_key.prod",
          classification: "credential"
        }
      ],
      exchangePolicyRules: []
    });
    const requesterJwt = await authFixture.issueToken({ agentId: "agent:crm-bot" });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: {
        authorization: `Bearer ${requesterJwt}`
      },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "agent:payment-bot"
      }
    });

    expect(createRes.statusCode).toBe(403);
    await app.close();
  });

  it("returns generic not available to non-owner revoke probes and 200 to owner revoke", async () => {
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      secretRegistry: [
        {
          secretName: "stripe.api_key.prod",
          classification: "credential"
        }
      ],
      exchangePolicyRules: [
        {
          ruleId: "stripe-prod",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:crm-bot"],
          fulfillerIds: ["agent:payment-bot"]
        }
      ]
    });

    const requesterJwt = await authFixture.issueToken({ agentId: "agent:crm-bot" });
    const otherJwt = await authFixture.issueToken({ agentId: "agent:other-bot" });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: {
        authorization: `Bearer ${requesterJwt}`
      },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "agent:payment-bot"
      }
    });
    const created = createRes.json() as { exchange_id: string };

    const wrongRevoke = await app.inject({
      method: "DELETE",
      url: `/api/v2/secret/exchange/revoke/${created.exchange_id}`,
      headers: {
        authorization: `Bearer ${otherJwt}`
      }
    });
    expect(wrongRevoke.statusCode).toBe(410);

    const revokeRes = await app.inject({
      method: "DELETE",
      url: `/api/v2/secret/exchange/revoke/${created.exchange_id}`,
      headers: {
        authorization: `Bearer ${requesterJwt}`
      }
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json()).toEqual({ status: "revoked" });

    await app.close();
  });

  it("denies an exchange for an unregistered secret even if a rule exists", async () => {
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      secretRegistry: [],
      exchangePolicyRules: [
        {
          ruleId: "missing-secret",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:crm-bot"],
          fulfillerIds: ["agent:payment-bot"]
        }
      ]
    });
    const requesterJwt = await authFixture.issueToken({ agentId: "agent:crm-bot" });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: {
        authorization: `Bearer ${requesterJwt}`
      },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "agent:payment-bot"
      }
    });

    expect(createRes.statusCode).toBe(403);
    await app.close();
  });

  it("allows same-ring exchanges for named secrets when configured", async () => {
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      secretRegistry: [
        {
          secretName: "stripe.api_key.prod",
          classification: "credential"
        }
      ],
      exchangePolicyRules: [
        {
          ruleId: "finance.same-ring.stripe-prod",
          secretName: "stripe.api_key.prod",
          sameRing: true,
          allowedRings: ["finance"]
        }
      ]
    });

    const requesterJwt = await authFixture.issueToken({
      agentId: "spiffe://myorg.local/ring/finance/crm-bot"
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: {
        authorization: `Bearer ${requesterJwt}`
      },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "spiffe://myorg.local/ring/finance/payment-bot"
      }
    });

    expect(createRes.statusCode).toBe(201);
    await app.close();
  });

  it("denies same-ring policy when requester and fulfiller are in different rings", async () => {
    const app = await buildApp({
      useInMemoryStore: true,
      hmacSecret: "test-hmac",
      secretRegistry: [
        {
          secretName: "stripe.api_key.prod",
          classification: "credential"
        }
      ],
      exchangePolicyRules: [
        {
          ruleId: "finance.same-ring.stripe-prod",
          secretName: "stripe.api_key.prod",
          sameRing: true,
          allowedRings: ["finance"]
        }
      ]
    });

    const requesterJwt = await authFixture.issueToken({
      agentId: "spiffe://myorg.local/ring/finance/crm-bot"
    });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: {
        authorization: `Bearer ${requesterJwt}`
      },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "spiffe://myorg.local/ring/devops/deploy-bot"
      }
    });

    expect(createRes.statusCode).toBe(403);
    await app.close();
  });
});
