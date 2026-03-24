import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { __resetJwksCacheForTests } from "../src/middleware/auth.js";
import { signGuestFulfillmentToken, verifyFulfillmentToken } from "../src/services/crypto.js";
import { createGatewayAuthFixture, type GatewayAuthFixture } from "./gateway-auth.fixture.js";

describe("exchange routes", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalProviders = process.env.SPS_AGENT_AUTH_PROVIDERS_JSON;
  const originalHostedMode = process.env.SPS_HOSTED_MODE;
  const originalUserJwtSecret = process.env.SPS_USER_JWT_SECRET;
  let authFixture: GatewayAuthFixture;

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    authFixture = await createGatewayAuthFixture();
    process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = JSON.stringify([
      { name: "legacy-gateway", jwks_file: authFixture.jwksPath, issuer: "gateway", audience: "sps" }
    ]);
    process.env.SPS_HOSTED_MODE = "";
    process.env.SPS_USER_JWT_SECRET = "test-user-jwt-secret";
    __resetJwksCacheForTests();
  });

  afterEach(async () => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.SPS_AGENT_AUTH_PROVIDERS_JSON = originalProviders;
    process.env.SPS_HOSTED_MODE = originalHostedMode;
    process.env.SPS_USER_JWT_SECRET = originalUserJwtSecret;
    __resetJwksCacheForTests();
    await authFixture.cleanup();
  });

  async function signUserToken(
    workspaceId: string,
    role: "workspace_admin" | "workspace_operator" | "workspace_viewer",
    subject: string
  ) {
    return new SignJWT({
      email: `${subject}@example.com`,
      workspace_id: workspaceId,
      role
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("sps")
      .setAudience("sps-user")
      .setSubject(subject)
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode("test-user-jwt-secret"));
  }

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

  it("denies cross-workspace fulfillment in hosted mode", async () => {
    process.env.SPS_HOSTED_MODE = "1";
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

    const requesterJwt = await authFixture.issueToken({
      agentId: "agent:crm-bot",
      claims: { role: "gateway", workspace_id: "ws-alpha" }
    });
    const fulfillerJwt = await authFixture.issueToken({
      agentId: "agent:payment-bot",
      claims: { role: "gateway", workspace_id: "ws-beta" }
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
        fulfiller_hint: "agent:payment-bot"
      }
    });

    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as { fulfillment_token: string };

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

    expect(fulfillRes.statusCode).toBe(410);
    await app.close();
  });

  it("rejects guest-scoped fulfillment tokens for standard agent exchanges", async () => {
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
    const created = createRes.json() as { fulfillment_token: string; expires_at: number };
    const claims = await verifyFulfillmentToken(created.fulfillment_token, "test-hmac");
    const guestToken = await signGuestFulfillmentToken(
      {
        exchange_id: claims.exchange_id,
        requester_id: claims.requester_id,
        workspace_id: claims.workspace_id,
        secret_name: claims.secret_name,
        purpose: claims.purpose,
        policy_hash: claims.policy_hash,
        approval_reference: claims.approval_reference
      },
      "test-hmac",
      created.expires_at
    );

    const fulfillRes = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/fulfill",
      headers: {
        authorization: `Bearer ${fulfillerJwt}`
      },
      payload: {
        fulfillment_token: guestToken
      }
    });

    expect(fulfillRes.statusCode).toBe(409);
    expect(fulfillRes.json()).toEqual({ error: "Exchange token no longer matches request" });
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

  it("allows cross-ring exchanges when requester and fulfiller rings match the configured rule", async () => {
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
          ruleId: "finance-to-payments",
          secretName: "stripe.api_key.prod",
          requesterRings: ["finance"],
          fulfillerRings: ["payments"]
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
        fulfiller_hint: "spiffe://myorg.local/ring/payments/payment-bot"
      }
    });

    expect(createRes.statusCode).toBe(201);
    expect(createRes.json()).toMatchObject({
      policy: {
        mode: "allow",
        requester_ring: "finance",
        fulfiller_ring: "payments",
        secret_name: "stripe.api_key.prod"
      }
    });

    await app.close();
  });

  it("returns approval-required policy details when a matching rule requires human approval", async () => {
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
          ruleId: "finance-to-ops-approval",
          secretName: "stripe.api_key.prod",
          requesterRings: ["finance"],
          fulfillerRings: ["ops"],
          mode: "pending_approval",
          reason: "cross-ring exchange requires human approval"
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
        fulfiller_hint: "spiffe://myorg.local/ring/ops/deploy-bot"
      }
    });

    expect(createRes.statusCode).toBe(403);
    expect(createRes.json()).toMatchObject({
      error: "Exchange requires human approval",
      policy: {
        mode: "pending_approval",
        approval_required: true,
        rule_id: "finance-to-ops-approval",
        requester_ring: "finance",
        fulfiller_ring: "ops",
        secret_name: "stripe.api_key.prod",
        reason: "cross-ring exchange requires human approval"
      }
    });
    expect((createRes.json() as { policy: { approval_reference: string } }).policy.approval_reference).toMatch(/^apr_[a-f0-9]{24}$/);

    await app.close();
  });

  it("creates an approval request and allows the requester to retry after approval", async () => {
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
          ruleId: "finance-to-ops-approval",
          secretName: "stripe.api_key.prod",
          requesterRings: ["finance"],
          fulfillerRings: ["ops"],
          approverIds: ["agent:security-lead"],
          mode: "pending_approval",
          reason: "cross-ring exchange requires human approval"
        }
      ]
    });

    const requesterJwt = await authFixture.issueToken({
      agentId: "spiffe://myorg.local/ring/finance/crm-bot"
    });
    const fulfillerJwt = await authFixture.issueToken({
      agentId: "spiffe://myorg.local/ring/ops/deploy-bot"
    });
    const approverJwt = await authFixture.issueToken({
      agentId: "agent:security-lead"
    });
    const otherJwt = await authFixture.issueToken({
      agentId: "agent:random-bot"
    });

    const firstCreate = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: {
        authorization: `Bearer ${requesterJwt}`
      },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "spiffe://myorg.local/ring/ops/deploy-bot"
      }
    });

    expect(firstCreate.statusCode).toBe(403);
    const pendingApproval = firstCreate.json() as { policy: { approval_reference: string } };

    const approvalStatus = await app.inject({
      method: "GET",
      url: `/api/v2/secret/exchange/approval/${pendingApproval.policy.approval_reference}`,
      headers: {
        authorization: `Bearer ${requesterJwt}`
      }
    });
    expect(approvalStatus.statusCode).toBe(200);
    expect(approvalStatus.json()).toMatchObject({
      status: "pending",
      requester_id: "spiffe://myorg.local/ring/finance/crm-bot",
      fulfiller_hint: "spiffe://myorg.local/ring/ops/deploy-bot"
    });

    const unauthorizedApprove = await app.inject({
      method: "POST",
      url: `/api/v2/secret/exchange/approval/${pendingApproval.policy.approval_reference}/approve`,
      headers: {
        authorization: `Bearer ${otherJwt}`
      }
    });
    expect(unauthorizedApprove.statusCode).toBe(410);

    const approve = await app.inject({
      method: "POST",
      url: `/api/v2/secret/exchange/approval/${pendingApproval.policy.approval_reference}/approve`,
      headers: {
        authorization: `Bearer ${approverJwt}`
      }
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({
      approval_reference: pendingApproval.policy.approval_reference,
      status: "approved",
      decided_by: "agent:security-lead"
    });

    const secondCreate = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: {
        authorization: `Bearer ${requesterJwt}`
      },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "spiffe://myorg.local/ring/ops/deploy-bot"
      }
    });

    expect(secondCreate.statusCode).toBe(201);
    const created = secondCreate.json() as { exchange_id: string; fulfillment_token: string; policy: { approval_reference: string } };
    expect(created.policy.approval_reference).toBe(pendingApproval.policy.approval_reference);

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

    const retrieveRes = await app.inject({
      method: "GET",
      url: `/api/v2/secret/exchange/retrieve/${created.exchange_id}`,
      headers: {
        authorization: `Bearer ${requesterJwt}`
      }
    });
    expect(retrieveRes.statusCode).toBe(200);

    await app.close();
  });

  it("returns a rejected approval state on later retries", async () => {
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
          ruleId: "finance-to-ops-approval",
          secretName: "stripe.api_key.prod",
          requesterRings: ["finance"],
          fulfillerRings: ["ops"],
          approverIds: ["agent:security-lead"],
          mode: "pending_approval",
          reason: "cross-ring exchange requires human approval"
        }
      ]
    });

    const requesterJwt = await authFixture.issueToken({
      agentId: "spiffe://myorg.local/ring/finance/crm-bot"
    });
    const approverJwt = await authFixture.issueToken({
      agentId: "agent:security-lead"
    });

    const firstCreate = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: {
        authorization: `Bearer ${requesterJwt}`
      },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "spiffe://myorg.local/ring/ops/deploy-bot"
      }
    });

    const pendingApproval = firstCreate.json() as { policy: { approval_reference: string } };

    const reject = await app.inject({
      method: "POST",
      url: `/api/v2/secret/exchange/approval/${pendingApproval.policy.approval_reference}/reject`,
      headers: {
        authorization: `Bearer ${approverJwt}`
      }
    });
    expect(reject.statusCode).toBe(200);
    expect(reject.json()).toMatchObject({
      status: "rejected",
      decided_by: "agent:security-lead"
    });

    const retryCreate = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: {
        authorization: `Bearer ${requesterJwt}`
      },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "spiffe://myorg.local/ring/ops/deploy-bot"
      }
    });

    expect(retryCreate.statusCode).toBe(403);
    expect(retryCreate.json()).toMatchObject({
      error: "Exchange approval was rejected",
      approval_status: "rejected"
    });

    await app.close();
  });

  it("exposes exchange lifecycle records via admin-only endpoints", async () => {
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
    const adminJwt = await authFixture.issueToken({ agentId: "agent:admin", claims: { role: "gateway", admin: true } });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: { authorization: `Bearer ${requesterJwt}` },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "agent:payment-bot"
      }
    });
    const created = createRes.json() as { exchange_id: string; fulfillment_token: string };

    await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/fulfill",
      headers: { authorization: `Bearer ${fulfillerJwt}` },
      payload: { fulfillment_token: created.fulfillment_token }
    });
    await app.inject({
      method: "POST",
      url: `/api/v2/secret/exchange/submit/${created.exchange_id}`,
      headers: { authorization: `Bearer ${fulfillerJwt}` },
      payload: { enc: "ZW5j", ciphertext: "Y2lwaGVy" }
    });
    await app.inject({
      method: "GET",
      url: `/api/v2/secret/exchange/retrieve/${created.exchange_id}`,
      headers: { authorization: `Bearer ${requesterJwt}` }
    });

    const nonAdmin = await app.inject({
      method: "GET",
      url: `/api/v2/secret/exchange/admin/exchange/${created.exchange_id}/lifecycle`,
      headers: { authorization: `Bearer ${requesterJwt}` }
    });
    expect(nonAdmin.statusCode).toBe(403);

    const lifecycleRes = await app.inject({
      method: "GET",
      url: `/api/v2/secret/exchange/admin/exchange/${created.exchange_id}/lifecycle`,
      headers: { authorization: `Bearer ${adminJwt}` }
    });
    expect(lifecycleRes.statusCode).toBe(200);
    expect(lifecycleRes.json()).toMatchObject({
      exchange_id: created.exchange_id
    });
    expect((lifecycleRes.json() as { records: Array<{ event_type: string }> }).records.map((record) => record.event_type)).toEqual([
      "exchange_requested",
      "exchange_reserved",
      "exchange_submitted",
      "exchange_retrieved"
    ]);

    await app.close();
  });

  it("stores approval history for admin-only review endpoints", async () => {
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
          ruleId: "finance-to-ops-approval",
          secretName: "stripe.api_key.prod",
          requesterRings: ["finance"],
          fulfillerRings: ["ops"],
          approverIds: ["agent:security-lead"],
          mode: "pending_approval",
          reason: "cross-ring exchange requires human approval"
        }
      ]
    });

    const requesterJwt = await authFixture.issueToken({
      agentId: "spiffe://myorg.local/ring/finance/crm-bot"
    });
    const approverJwt = await authFixture.issueToken({
      agentId: "agent:security-lead"
    });
    const adminJwt = await authFixture.issueToken({ agentId: "agent:admin", claims: { role: "gateway", admin: true } });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: { authorization: `Bearer ${requesterJwt}` },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "spiffe://myorg.local/ring/ops/deploy-bot"
      }
    });
    const approvalReference = (createRes.json() as { policy: { approval_reference: string } }).policy.approval_reference;

    await app.inject({
      method: "POST",
      url: `/api/v2/secret/exchange/approval/${approvalReference}/approve`,
      headers: { authorization: `Bearer ${approverJwt}` }
    });

    const historyRes = await app.inject({
      method: "GET",
      url: `/api/v2/secret/exchange/admin/approval/${approvalReference}/history`,
      headers: { authorization: `Bearer ${adminJwt}` }
    });
    expect(historyRes.statusCode).toBe(200);
    expect(historyRes.json()).toMatchObject({
      approval_reference: approvalReference,
      approval: {
        approval_reference: approvalReference,
        status: "approved",
        decided_by: "agent:security-lead"
      }
    });
    expect((historyRes.json() as { records: Array<{ event_type: string; status: string | null }> }).records).toEqual([
      expect.objectContaining({ event_type: "approval_requested", status: "pending" }),
      expect.objectContaining({ event_type: "approval_decided", status: "approved" })
    ]);

    await app.close();
  });

  it("allows workspace operators to approve pending approvals through user auth", async () => {
    process.env.SPS_HOSTED_MODE = "1";

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
          ruleId: "finance-to-ops-approval",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:requester-bot"],
          fulfillerIds: ["agent:fulfiller-bot"],
          approverIds: ["agent:security-lead"],
          mode: "pending_approval",
          reason: "cross-ring exchange requires human approval"
        }
      ]
    });

    const workspaceId = "workspace-alpha";
    const requesterJwt = await authFixture.issueToken({
      agentId: "agent:requester-bot",
      claims: { role: "gateway", workspace_id: workspaceId }
    });
    const operatorJwt = await signUserToken(workspaceId, "workspace_operator", "user-operator");

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: { authorization: `Bearer ${requesterJwt}` },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "agent:fulfiller-bot"
      }
    });
    expect(createRes.statusCode).toBe(403);

    const approvalReference = (createRes.json() as { policy: { approval_reference: string } }).policy.approval_reference;
    const approveRes = await app.inject({
      method: "POST",
      url: `/api/v2/secret/exchange/admin/approval/${approvalReference}/approve`,
      headers: { authorization: `Bearer ${operatorJwt}` }
    });

    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json()).toMatchObject({
      approval_reference: approvalReference,
      status: "approved",
      decided_by: "user-operator"
    });

    await app.close();
  });

  it("keeps workspace viewers read-only on user approval actions", async () => {
    process.env.SPS_HOSTED_MODE = "1";

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
          ruleId: "finance-to-ops-approval",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:requester-bot"],
          fulfillerIds: ["agent:fulfiller-bot"],
          approverIds: ["agent:security-lead"],
          mode: "pending_approval",
          reason: "cross-ring exchange requires human approval"
        }
      ]
    });

    const workspaceId = "workspace-alpha";
    const requesterJwt = await authFixture.issueToken({
      agentId: "agent:requester-bot",
      claims: { role: "gateway", workspace_id: workspaceId }
    });
    const viewerJwt = await signUserToken(workspaceId, "workspace_viewer", "user-viewer");

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: { authorization: `Bearer ${requesterJwt}` },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "agent:fulfiller-bot"
      }
    });
    expect(createRes.statusCode).toBe(403);

    const approvalReference = (createRes.json() as { policy: { approval_reference: string } }).policy.approval_reference;
    const rejectRes = await app.inject({
      method: "POST",
      url: `/api/v2/secret/exchange/admin/approval/${approvalReference}/reject`,
      headers: { authorization: `Bearer ${viewerJwt}` }
    });

    expect(rejectRes.statusCode).toBe(403);
    expect(rejectRes.json()).toMatchObject({
      error: "Insufficient role"
    });

    await app.close();
  });

  it("supports validated prior_exchange_id lineage on later exchange requests", async () => {
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
    const adminJwt = await authFixture.issueToken({ agentId: "agent:admin", claims: { role: "gateway", admin: true } });

    const firstCreate = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: { authorization: `Bearer ${requesterJwt}` },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "agent:payment-bot"
      }
    });
    const firstExchangeId = (firstCreate.json() as { exchange_id: string }).exchange_id;

    const invalidRetry = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: { authorization: `Bearer ${otherJwt}` },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "agent:payment-bot",
        prior_exchange_id: firstExchangeId
      }
    });
    expect(invalidRetry.statusCode).toBe(409);

    const secondCreate = await app.inject({
      method: "POST",
      url: "/api/v2/secret/exchange/request",
      headers: { authorization: `Bearer ${requesterJwt}` },
      payload: {
        public_key: "cHVibGlj",
        secret_name: "stripe.api_key.prod",
        purpose: "charge-order",
        fulfiller_hint: "agent:payment-bot",
        prior_exchange_id: firstExchangeId
      }
    });
    expect(secondCreate.statusCode).toBe(201);
    const secondExchangeId = (secondCreate.json() as { exchange_id: string }).exchange_id;

    const adminDetail = await app.inject({
      method: "GET",
      url: `/api/v2/secret/exchange/admin/exchange/${secondExchangeId}`,
      headers: { authorization: `Bearer ${adminJwt}` }
    });
    expect(adminDetail.statusCode).toBe(200);
    expect(adminDetail.json()).toMatchObject({
      exchange_id: secondExchangeId,
      prior_exchange_id: firstExchangeId,
      supersedes_exchange_id: firstExchangeId
    });

    const lifecycleRes = await app.inject({
      method: "GET",
      url: `/api/v2/secret/exchange/admin/exchange/${secondExchangeId}/lifecycle`,
      headers: { authorization: `Bearer ${adminJwt}` }
    });
    expect(lifecycleRes.statusCode).toBe(200);
    expect((lifecycleRes.json() as { records: Array<{ event_type: string; metadata: { prior_exchange_id: string | null } | null }> }).records[0]).toMatchObject({
      event_type: "exchange_requested",
      metadata: {
        prior_exchange_id: firstExchangeId
      }
    });

    await app.close();
  });
});
