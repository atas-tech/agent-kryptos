import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/index.js";
import { StripeBillingProvider } from "../src/services/billing.js";
import { cleanupExpiredAuditRecords } from "../src/services/audit.js";
import { findAuditLeaks } from "./helpers/audit-leak-scanner.js";

const runPgIntegration = process.env.SPS_PG_INTEGRATION === "1";
const describePg = runPgIntegration ? describe : describe.skip;
const migrationsDir = new URL("../src/db/migrations/", import.meta.url);

type App = Awaited<ReturnType<typeof buildApp>>;

let adminPool: Pool | null = null;
let originalUserJwtSecret: string | undefined;
let originalAgentJwtSecret: string | undefined;
let originalHostedMode: string | undefined;

function randomSchema(prefix: string): string {
  return `${prefix}_${Math.random().toString(16).slice(2, 10)}`;
}

function withSearchPath(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

async function createIsolatedPool(): Promise<{ pool: Pool; schema: string }> {
  if (!adminPool || !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set for PostgreSQL integration tests");
  }

  const schema = randomSchema("e2e");
  await adminPool.query(`CREATE SCHEMA "${schema}"`);

  return {
    schema,
    pool: createDbPool({
      connectionString: withSearchPath(process.env.DATABASE_URL, schema),
      max: 1
    })
  };
}

async function disposeIsolatedPool(pool: Pool, schema: string): Promise<void> {
  await pool.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

async function createApp(pool: Pool, stripeClient?: any): Promise<App> {
  const defaultMockStripe = {
    customers: { create: async () => ({ id: "cus_mock" }) },
    checkout: { sessions: { create: async () => ({ id: "cs_mock", url: "https://stripe.com/mock" }) } },
    billingPortal: { sessions: { create: async () => ({ id: "cp_mock", url: "https://stripe.com/portal" }) } },
    webhooks: { constructEvent: (payload: string) => JSON.parse(payload) }
  };

  const billingProvider = new StripeBillingProvider(stripeClient ?? (defaultMockStripe as any));

  return buildApp({
    db: pool,
    useInMemoryStore: true,
    trustProxy: true,
    hmacSecret: "test-hmac",
    baseUrl: "http://localhost:3100",
    billingProvider
  });
}

async function registerOwner(app: App, identity: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/register",
    payload: {
      email: `${identity}@example.com`,
      password: "Password123!",
      workspace_slug: `${identity}-space`,
      display_name: `${identity} Space`
    }
  });

  expect(response.statusCode).toBe(201);
  return response.json() as {
    access_token: string;
    refresh_token: string;
    user: { id: string; workspace_id: string };
  };
}

async function verifyOwner(app: App, pool: Pool, email: string): Promise<void> {
  await pool.query("UPDATE users SET email_verified = true WHERE email = $1", [email]);
}

async function login(app: App, email: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    payload: {
      email,
      password
    }
  });

  expect(response.statusCode).toBe(200);
  return response.json() as {
    access_token: string;
    refresh_token: string;
    user: { force_password_change: boolean };
  };
}

async function changePassword(app: App, accessToken: string, currentPassword: string, nextPassword: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/change-password",
    headers: {
      authorization: `Bearer ${accessToken}`
    },
    payload: {
      current_password: currentPassword,
      next_password: nextPassword
    }
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { access_token: string }).access_token;
}

async function enrollAgent(app: App, accessToken: string, agentId: string, displayName?: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/agents",
    headers: {
      authorization: `Bearer ${accessToken}`
    },
    payload: displayName ? { agent_id: agentId, display_name: displayName } : { agent_id: agentId }
  });

  return response;
}

async function mintAgentToken(app: App, apiKey: string, ipAddress: string) {
  return app.inject({
    method: "POST",
    url: "/api/v2/agents/token",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "x-forwarded-for": ipAddress
    }
  });
}

async function simulateStripeWebhook(app: App, payload: any, signature = "valid") {
  return app.inject({
    method: "POST",
    url: "/api/v2/webhook/stripe",
    headers: {
      "stripe-signature": signature,
      "content-type": "application/json"
    },
    payload: JSON.stringify(payload)
  });
}

describePg("Phase 3A E2E", { timeout: 30_000 }, () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set for PostgreSQL integration tests");
    }

    originalUserJwtSecret = process.env.SPS_USER_JWT_SECRET;
    originalAgentJwtSecret = process.env.SPS_AGENT_JWT_SECRET;
    originalHostedMode = process.env.SPS_HOSTED_MODE;

    process.env.SPS_USER_JWT_SECRET = "test-user-jwt-secret";
    process.env.SPS_AGENT_JWT_SECRET = "test-agent-jwt-secret";
    process.env.SPS_HOSTED_MODE = "1";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.SPS_STRIPE_STANDARD_PRICE_ID = "price_test";
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    adminPool = createDbPool({
      connectionString: process.env.DATABASE_URL,
      max: 1
    });
  });

  afterAll(async () => {
    process.env.SPS_USER_JWT_SECRET = originalUserJwtSecret;
    process.env.SPS_AGENT_JWT_SECRET = originalAgentJwtSecret;
    process.env.SPS_HOSTED_MODE = originalHostedMode;
    await adminPool?.end();
    adminPool = null;
  });

  it("covers hosted agent enrollment, bootstrap minting, key rotation, revoke, and re-enrollment", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createApp(pool);
      const owner = await registerOwner(app, "lifecycle-owner");
      await verifyOwner(app, pool, "lifecycle-owner@example.com");

      const enrollResponse = await enrollAgent(app, owner.access_token, "test-agent", "Test Agent");
      expect(enrollResponse.statusCode).toBe(201);
      const enrolled = enrollResponse.json() as {
        bootstrap_api_key: string;
        agent: { agent_id: string; status: string };
      };
      expect(enrolled.bootstrap_api_key).toMatch(/^ak_/);
      expect(enrolled.agent).toMatchObject({
        agent_id: "test-agent",
        status: "active"
      });

      const tokenResponse = await mintAgentToken(app, enrolled.bootstrap_api_key, "1.2.3.4");
      expect(tokenResponse.statusCode).toBe(200);
      const agentAuth = tokenResponse.json() as { access_token: string };

      const requestResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/request",
        headers: {
          authorization: `Bearer ${agentAuth.access_token}`
        },
        payload: {
          public_key: "cHVi",
          description: "E2E Test Secret"
        }
      });
      expect(requestResponse.statusCode).toBe(201);
      const { request_id, secret_url } = requestResponse.json() as { request_id: string; secret_url: string };
      const submitSig = new URL(secret_url).searchParams.get("submit_sig");
      expect(submitSig).toBeTruthy();

      const submitResponse = await app.inject({
        method: "POST",
        url: `/api/v2/secret/submit/${request_id}?sig=${encodeURIComponent(submitSig!)}`,
        payload: {
          enc: "ZW5j",
          ciphertext: "Y2lwaGVy"
        }
      });
      expect(submitResponse.statusCode).toBe(201);

      const retrieveResponse = await app.inject({
        method: "GET",
        url: `/api/v2/secret/retrieve/${request_id}`,
        headers: {
          authorization: `Bearer ${agentAuth.access_token}`
        }
      });
      expect(retrieveResponse.statusCode).toBe(200);
      expect(retrieveResponse.json()).toEqual({ enc: "ZW5j", ciphertext: "Y2lwaGVy" });

      const rotateResponse = await app.inject({
        method: "POST",
        url: "/api/v2/agents/test-agent/rotate-key",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(rotateResponse.statusCode).toBe(200);
      const rotated = rotateResponse.json() as { bootstrap_api_key: string };
      expect(rotated.bootstrap_api_key).toMatch(/^ak_/);
      expect(rotated.bootstrap_api_key).not.toBe(enrolled.bootstrap_api_key);

      const oldKeyMintResponse = await mintAgentToken(app, enrolled.bootstrap_api_key, "1.2.3.5");
      expect(oldKeyMintResponse.statusCode).toBe(401);

      const newKeyMintResponse = await mintAgentToken(app, rotated.bootstrap_api_key, "1.2.3.6");
      expect(newKeyMintResponse.statusCode).toBe(200);

      const revokeResponse = await app.inject({
        method: "DELETE",
        url: "/api/v2/agents/test-agent",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(revokeResponse.statusCode).toBe(200);

      const revokedKeyMintResponse = await mintAgentToken(app, rotated.bootstrap_api_key, "1.2.3.7");
      expect(revokedKeyMintResponse.statusCode).toBe(401);

      const reenrollResponse = await enrollAgent(app, owner.access_token, "test-agent", "Test Agent Reloaded");
      expect(reenrollResponse.statusCode).toBe(201);
      const reenrolled = reenrollResponse.json() as {
        bootstrap_api_key: string;
        agent: { agent_id: string; display_name: string; status: string };
      };
      expect(reenrolled.agent).toMatchObject({
        agent_id: "test-agent",
        display_name: "Test Agent Reloaded",
        status: "active"
      });

      const reenrolledTokenResponse = await mintAgentToken(app, reenrolled.bootstrap_api_key, "1.2.3.8");
      expect(reenrolledTokenResponse.statusCode).toBe(200);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("covers RBAC boundaries for operators and viewers and preserves last-admin lockout", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createApp(pool);
      const owner = await registerOwner(app, "rbac-admin");
      await verifyOwner(app, pool, "rbac-admin@example.com");

      // Upgrade to standard to allow more than 1 member (free limit is 1)
      await simulateStripeWebhook(app, {
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_rbac",
            subscription: "sub_rbac",
            metadata: { workspace_id: owner.user.workspace_id }
          }
        }
      });

      const createOperatorResponse = await app.inject({
        method: "POST",
        url: "/api/v2/members",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          email: "operator@example.com",
          temporary_password: "OperatorTemp123!",
          role: "workspace_operator"
        }
      });
      expect(createOperatorResponse.statusCode).toBe(201);
      const operatorMember = createOperatorResponse.json() as { member: { id: string } };

      const operatorLogin = await login(app, "operator@example.com", "OperatorTemp123!");
      const operatorAccessToken = await changePassword(
        app,
        operatorLogin.access_token,
        "OperatorTemp123!",
        "OperatorNew123!"
      );

      const operatorEnrollResponse = await enrollAgent(app, operatorAccessToken, "operator-agent");
      expect(operatorEnrollResponse.statusCode).toBe(201);

      const operatorMemberCreateAttempt = await app.inject({
        method: "POST",
        url: "/api/v2/members",
        headers: {
          authorization: `Bearer ${operatorAccessToken}`
        },
        payload: {
          email: "viewer@example.com",
          temporary_password: "ViewerTemp123!",
          role: "workspace_viewer"
        }
      });
      expect(operatorMemberCreateAttempt.statusCode).toBe(403);

      const demoteResponse = await app.inject({
        method: "PATCH",
        url: `/api/v2/members/${operatorMember.member.id}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          role: "workspace_viewer"
        }
      });
      expect(demoteResponse.statusCode).toBe(200);

      const viewerLogin = await login(app, "operator@example.com", "OperatorNew123!");
      const viewerEnrollAttempt = await enrollAgent(app, viewerLogin.access_token, "viewer-agent");
      expect(viewerEnrollAttempt.statusCode).toBe(403);

      const lastAdminLockoutResponse = await app.inject({
        method: "PATCH",
        url: `/api/v2/members/${owner.user.id}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          role: "workspace_viewer"
        }
      });
      expect(lastAdminLockoutResponse.statusCode).toBe(409);
      expect(lastAdminLockoutResponse.json()).toEqual({
        error: "The last active workspace_admin cannot be demoted, suspended, or deleted",
        code: "last_admin_lockout"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("keeps hosted secret retrieval isolated by workspace", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createApp(pool);

      const ownerA = await registerOwner(app, "owner-a");
      await verifyOwner(app, pool, "owner-a@example.com");
      const enrollA = await enrollAgent(app, ownerA.access_token, "agent-a");
      expect(enrollA.statusCode).toBe(201);
      const keyA = (enrollA.json() as { bootstrap_api_key: string }).bootstrap_api_key;
      const tokenA = (await mintAgentToken(app, keyA, "2.2.2.1")).json() as { access_token: string };

      const ownerB = await registerOwner(app, "owner-b");
      await verifyOwner(app, pool, "owner-b@example.com");
      const enrollB = await enrollAgent(app, ownerB.access_token, "agent-b");
      expect(enrollB.statusCode).toBe(201);
      const keyB = (enrollB.json() as { bootstrap_api_key: string }).bootstrap_api_key;
      const tokenB = (await mintAgentToken(app, keyB, "2.2.2.2")).json() as { access_token: string };

      const requestA = await app.inject({
        method: "POST",
        url: "/api/v2/secret/request",
        headers: {
          authorization: `Bearer ${tokenA.access_token}`
        },
        payload: {
          public_key: "cHVi",
          description: "Secret A"
        }
      });
      expect(requestA.statusCode).toBe(201);
      const { request_id, secret_url } = requestA.json() as { request_id: string; secret_url: string };
      const submitSig = new URL(secret_url).searchParams.get("submit_sig");
      expect(submitSig).toBeTruthy();

      const submitA = await app.inject({
        method: "POST",
        url: `/api/v2/secret/submit/${request_id}?sig=${encodeURIComponent(submitSig!)}`,
        payload: {
          enc: "ZW5j",
          ciphertext: "Y2lwaGVyLWE="
        }
      });
      expect(submitA.statusCode).toBe(201);

      const crossRetrieve = await app.inject({
        method: "GET",
        url: `/api/v2/secret/retrieve/${request_id}`,
        headers: {
          authorization: `Bearer ${tokenB.access_token}`
        }
      });
      expect(crossRetrieve.statusCode).toBe(410);

      const selfRetrieve = await app.inject({
        method: "GET",
        url: `/api/v2/secret/retrieve/${request_id}`,
        headers: {
          authorization: `Bearer ${tokenA.access_token}`
        }
      });
      expect(selfRetrieve.statusCode).toBe(200);
      expect(selfRetrieve.json()).toEqual({ enc: "ZW5j", ciphertext: "Y2lwaGVyLWE=" });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("enforces owner verification for high-risk actions and preserves logout semantics", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createApp(pool);
      const owner = await registerOwner(app, "refresh-owner");

      const unverifiedEnrollResponse = await enrollAgent(app, owner.access_token, "refresh-agent");
      expect(unverifiedEnrollResponse.statusCode).toBe(403);
      expect(unverifiedEnrollResponse.json()).toEqual({
        error: "Workspace owner email must be verified before performing this action",
        code: "workspace_owner_unverified"
      });

      const logoutResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/logout",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(logoutResponse.statusCode).toBe(204);

      const stillValidAccessResponse = await app.inject({
        method: "GET",
        url: "/api/v2/auth/me",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(stillValidAccessResponse.statusCode).toBe(200);

      const refreshAfterLogoutResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/refresh",
        payload: {
          refresh_token: owner.refresh_token
        }
      });
      expect(refreshAfterLogoutResponse.statusCode).toBe(401);

      await verifyOwner(app, pool, "refresh-owner@example.com");
      const freshLogin = await login(app, "refresh-owner@example.com", "Password123!");

      const enrollResponse = await enrollAgent(app, freshLogin.access_token, "refresh-agent");
      expect(enrollResponse.statusCode).toBe(201);
      const enrolled = enrollResponse.json() as { bootstrap_api_key: string };

      const tokenResponse = await mintAgentToken(app, enrolled.bootstrap_api_key, "3.3.3.3");
      expect(tokenResponse.statusCode).toBe(200);

      const revokeResponse = await app.inject({
        method: "DELETE",
        url: "/api/v2/agents/refresh-agent",
        headers: {
          authorization: `Bearer ${freshLogin.access_token}`
        }
      });
      expect(revokeResponse.statusCode).toBe(200);

      const revokedCredentialResponse = await mintAgentToken(app, enrolled.bootstrap_api_key, "3.3.3.4");
      expect(revokedCredentialResponse.statusCode).toBe(401);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("handles subscription upgrades and quota expansion", async () => {
    const { pool, schema } = await createIsolatedPool();
    const mockStripe = {
      customers: { create: async () => ({ id: "cus_upgrade" }) },
      checkout: { sessions: { create: async () => ({ id: "cs_upgrade", url: "https://stripe.com/pay" }) } },
      webhooks: { constructEvent: (payload: string) => JSON.parse(payload) }
    };

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createApp(pool, mockStripe);
      const owner = await registerOwner(app, "billing-upgrade");
      await verifyOwner(app, pool, "billing-upgrade@example.com");

      // 1. Keep one agent's key for quota testing
      const firstAgentRes = await enrollAgent(app, owner.access_token, "quota-agent");
      expect(firstAgentRes.statusCode).toBe(201);
      const quotaAgentKey = firstAgentRes.json().bootstrap_api_key;

      // 2. Fill the agent quota (remaining 4 to reach 5)
      for (let i = 1; i <= 4; i++) {
        expect((await enrollAgent(app, owner.access_token, `extra-${i}`)).statusCode).toBe(201);
      }
      
      // 3. Verify reaching limit
      const limitRes = await enrollAgent(app, owner.access_token, "limit-breaker");
      expect(limitRes.statusCode).toBe(429);
      expect(limitRes.json().code).toBe("quota_exceeded");

      // 4. Verify secret request quota (limit 10)
      const agentToken = (await mintAgentToken(app, quotaAgentKey, "1.1.1.1")).json().access_token;
      for (let i = 1; i <= 10; i++) {
        const reqRes = await app.inject({
          method: "POST",
          url: "/api/v2/secret/request",
          headers: { authorization: `Bearer ${agentToken}` },
          payload: { public_key: "cHVi", description: `Req ${i}` }
        });
        expect(reqRes.statusCode).toBe(201);
      }
      const reqLimitRes = await app.inject({
        method: "POST",
        url: "/api/v2/secret/request",
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { public_key: "cHVi", description: "Over limit" }
      });
      expect(reqLimitRes.statusCode).toBe(429);

      // 5. Upgrade to standard via Webhook
      const upgradeWebhookRes = await simulateStripeWebhook(app, {
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_upgrade",
            subscription: "sub_upgrade",
            metadata: { workspace_id: owner.user.workspace_id }
          }
        }
      });
      expect(upgradeWebhookRes.statusCode).toBe(200);

      // 6. Verify expanded quotas
      const expandedEnrollRes = await enrollAgent(app, owner.access_token, "limit-breaker");
      expect(expandedEnrollRes.statusCode).toBe(201);

      const expandedReqRes = await app.inject({
        method: "POST",
        url: "/api/v2/secret/request",
        headers: { authorization: `Bearer ${agentToken}` },
        payload: { public_key: "cHVi", description: "Expanded quota" }
      });
      expect(expandedReqRes.statusCode).toBe(201);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("handles subscription downgrades and webhook security", async () => {
    const { pool, schema } = await createIsolatedPool();
    const mockStripe = {
      customers: { create: async () => ({ id: "cus_downgrade" }) },
      checkout: { sessions: { create: async () => ({ id: "cs_downgrade", url: "https://stripe.com/pay" }) } },
      webhooks: { 
        constructEvent: (payload: string, sig: string) => {
          if (sig === "invalid") throw new Error("Invalid signature");
          return JSON.parse(payload);
        }
      }
    };

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createApp(pool, mockStripe);
      const owner = await registerOwner(app, "billing-down");
      await verifyOwner(app, pool, "billing-down@example.com");

      // 1. Upgrade first
      await simulateStripeWebhook(app, {
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_downgrade",
            subscription: "sub_downgrade",
            metadata: { workspace_id: owner.user.workspace_id }
          }
        }
      });

      // 2. Test Downgrade
      const downgradeRes = await simulateStripeWebhook(app, {
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_downgrade",
            customer: "cus_downgrade"
          }
        }
      });
      expect(downgradeRes.statusCode).toBe(200);

      const billingRes = await app.inject({
        method: "GET",
        url: "/api/v2/billing",
        headers: { authorization: `Bearer ${owner.access_token}` }
      });
      expect(billingRes.json().billing.tier).toBe("free");

      // 3. Test Webhook Security (Invalid Signature)
      const securityRes = await simulateStripeWebhook(app, { type: "any" }, "invalid");
      expect(securityRes.statusCode).toBe(400);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("enforces rate limits for registration, login, and agent token requests", async () => {
    const { pool, schema } = await createIsolatedPool();
    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createApp(pool);

      const testIp = "1.2.3.4";

      // 1. Test Registration Rate Limit (limit 3 per minute)
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v2/auth/register",
          headers: { "x-forwarded-for": testIp },
          payload: {
            email: `limit-${i}@example.com`,
            password: "Password123!",
            workspace_slug: `space-${i}-${Math.random().toString(36).slice(2, 8)}`,
            display_name: "Space"
          }
        });
        expect(res.statusCode).toBe(201);
      }
      const regLimitRes = await app.inject({
        method: "POST",
        url: "/api/v2/auth/register",
        headers: { "x-forwarded-for": testIp },
        payload: {
          email: "overflow@example.com",
          password: "Password123!",
          workspace_slug: "overflow",
          display_name: "Space"
        }
      });
      expect(regLimitRes.statusCode).toBe(429);
      expect(regLimitRes.headers["retry-after"]).toBeDefined();

      // 2. Test Login Rate Limit (limit 10 per minute)
      for (let i = 0; i < 10; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v2/auth/login",
          headers: { "x-forwarded-for": testIp },
          payload: { email: "limit-0@example.com", password: "wrong" }
        });
        expect(res.statusCode).toBe(401);
      }
      const loginLimitRes = await app.inject({
        method: "POST",
        url: "/api/v2/auth/login",
        headers: { "x-forwarded-for": testIp },
        payload: { email: "limit-0@example.com", password: "wrong" }
      });
      expect(loginLimitRes.statusCode).toBe(429);

      // 3. Test Agent Token Rate Limit (limit 5 per minute)
      const owner = await registerOwner(app, "rate-limit-owner");
      await verifyOwner(app, pool, "rate-limit-owner@example.com");
      const agentRes = await enrollAgent(app, owner.access_token, "rl-agent");
      const bootstrapKey = agentRes.json().bootstrap_api_key;

      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v2/agents/token",
          headers: {
            "x-forwarded-for": testIp,
            authorization: `Bearer ${bootstrapKey}`
          }
        });
        expect(res.statusCode).toBe(200);
      }
      const tokenLimitRes = await app.inject({
        method: "POST",
        url: "/api/v2/agents/token",
        headers: {
          "x-forwarded-for": testIp,
          authorization: `Bearer ${bootstrapKey}`
        }
      });
      expect(tokenLimitRes.statusCode).toBe(429);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("provides workspace-scoped audit logs and security", async () => {
    const { pool, schema } = await createIsolatedPool();
    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createApp(pool);

      const ownerA = await registerOwner(app, "audit-a");
      await verifyOwner(app, pool, "audit-a@example.com");
      // Upgrade to standard to allow more members and check more audits
      await simulateStripeWebhook(app, {
        type: "checkout.session.completed",
        data: { object: { customer: "cus_a", subscription: "sub_a", metadata: { workspace_id: ownerA.user.workspace_id } } }
      });

      const ownerB = await registerOwner(app, "audit-b");
      await verifyOwner(app, pool, "audit-b@example.com");

      // Perform actions in A
      await enrollAgent(app, ownerA.access_token, "agent-a");
      const tempPass = "OperatorPass123!";
      const memberRes = await app.inject({
        method: "POST",
        url: "/api/v2/members",
        headers: { authorization: `Bearer ${ownerA.access_token}` },
        payload: { email: "op-a@example.com", temporary_password: tempPass, role: "workspace_operator" }
      });
      expect(memberRes.statusCode).toBe(201);

      // Verify Audit Logs for A
      const auditResA = await app.inject({
        method: "GET",
        url: "/api/v2/audit?limit=1",
        headers: { authorization: `Bearer ${ownerA.access_token}` }
      });
      expect(auditResA.statusCode).toBe(200);
      const auditPayloadA = auditResA.json() as { records: Array<any>; next_cursor: string | null };
      const recordsA = auditPayloadA.records;
      expect(auditPayloadA.next_cursor).toEqual(expect.any(String));
      
      // Check for workspace isolation and security
      expect(recordsA.every((r: any) => r.workspace_id === ownerA.user.workspace_id)).toBe(true);
      const leaks = findAuditLeaks(recordsA);
      expect(leaks).toEqual([]);
      const auditPayload = JSON.stringify(recordsA);
      expect(auditPayload).not.toContain(tempPass);
      expect(auditPayload).not.toContain("audit-b"); // Owner B's info shouldn't be here

      const auditResPage2 = await app.inject({
        method: "GET",
        url: `/api/v2/audit?limit=1&cursor=${encodeURIComponent(auditPayloadA.next_cursor ?? "")}`,
        headers: { authorization: `Bearer ${ownerA.access_token}` }
      });
      expect(auditResPage2.statusCode).toBe(200);
      expect((auditResPage2.json() as { records: Array<any> }).records.length).toBe(1);

      // Verify Audit Logs for B (should be empty for now as register/verify are not yet audited)
      const auditResB = await app.inject({
        method: "GET",
        url: "/api/v2/audit",
        headers: { authorization: `Bearer ${ownerB.access_token}` }
      });
      expect(auditResB.json().records.length).toBe(0);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("removes expired audit records on cleanup", async () => {
    const { pool, schema } = await createIsolatedPool();
    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createApp(pool);
      const owner = await registerOwner(app, "cleanup-owner");

      // Manually insert an old audit record
      await pool.query(
        "INSERT INTO audit_log (workspace_id, event_type, actor_type, resource_id, created_at) VALUES ($1, $2, $3, $4, $5)",
        [owner.user.workspace_id, "test_event", "system", "old-resource", new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)]
      );

      const deleted = await cleanupExpiredAuditRecords(pool, { retentionDays: 30 });
      expect(deleted).toBeGreaterThan(0);

      const remaining = await pool.query("SELECT * FROM audit_log WHERE resource_id = 'old-resource'");
      expect(remaining.rowCount).toBe(0);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
