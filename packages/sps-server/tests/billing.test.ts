import { SignJWT } from "jose";
import type Stripe from "stripe";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDbPool } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/index.js";
import { StripeBillingProvider, type BillingProvider, type StripeClientLike } from "../src/services/billing.js";

const runPgIntegration = process.env.SPS_PG_INTEGRATION === "1";
const describePg = runPgIntegration ? describe : describe.skip;
const migrationsDir = new URL("../src/db/migrations/", import.meta.url);

type App = Awaited<ReturnType<typeof buildApp>>;

let adminPool: Pool | null = null;
let originalUserJwtSecret: string | undefined;
let originalAgentJwtSecret: string | undefined;
let originalHostedMode: string | undefined;
let originalPriceId: string | undefined;
let originalWebhookSecret: string | undefined;

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

  const schema = randomSchema("billing");
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
    user: { workspace_id: string };
  };
}

async function verifyOwner(app: App, pool: Pool, email: string): Promise<void> {
  await pool.query("UPDATE users SET email_verified = true WHERE email = $1", [email]);
}

async function issueHostedAgentToken(workspaceId: string, agentId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    role: "gateway",
    workspace_id: workspaceId,
    workload_mode: "hosted"
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("sps")
    .setAudience("sps-agent")
    .setSubject(agentId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(process.env.SPS_AGENT_JWT_SECRET!));
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
    user: { workspace_id: string; role: string };
  };
}

function createStripeMock() {
  let nextEvent: Stripe.Event | null = null;

  const stripeClient: StripeClientLike = {
    customers: {
      create: vi.fn(async () => ({ id: "cus_test_123" }) as unknown as Stripe.Response<Stripe.Customer>)
    },
    checkout: {
      sessions: {
        create: vi.fn(async () => ({
          id: "cs_test_123",
          url: "https://checkout.stripe.test/session/cs_test_123"
        }) as unknown as Stripe.Response<Stripe.Checkout.Session>)
      }
    },
    billingPortal: {
      sessions: {
        create: vi.fn(async () => ({
          url: "https://billing.stripe.test/portal/bps_test_123"
        }) as unknown as Stripe.Response<Stripe.BillingPortal.Session>)
      }
    },
    webhooks: {
      constructEvent: vi.fn(() => {
        if (!nextEvent) {
          throw new Error("No webhook event configured");
        }
        return nextEvent;
      })
    }
  };

  return {
    stripeClient,
    setEvent(event: Stripe.Event) {
      nextEvent = event;
    }
  };
}

function createBillingProvider(stripeClient: StripeClientLike): BillingProvider {
  return new StripeBillingProvider(stripeClient, "whsec_test");
}

function checkoutCompletedEvent(workspaceId: string, customerId = "cus_test_123", subscriptionId = "sub_test_123"): Stripe.Event {
  return {
    id: "evt_checkout_completed",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_123",
        object: "checkout.session",
        customer: customerId,
        subscription: subscriptionId,
        metadata: {
          workspace_id: workspaceId
        }
      } as unknown as Stripe.Checkout.Session
    }
  } as Stripe.Event;
}

function subscriptionDeletedEvent(customerId = "cus_test_123", subscriptionId = "sub_test_123"): Stripe.Event {
  return {
    id: "evt_subscription_deleted",
    object: "event",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: subscriptionId,
        object: "subscription",
        customer: customerId
      } as Stripe.Subscription
    }
  } as Stripe.Event;
}

async function createBillingApp(pool: Pool, provider: BillingProvider): Promise<App> {
  return buildApp({
    db: pool,
    billingProvider: provider,
    useInMemoryStore: true,
    trustProxy: true,
    hmacSecret: "test-hmac",
    baseUrl: "http://localhost:3100",
    secretRegistry: [{
      secretName: "stripe.api_key.prod",
      classification: "restricted"
    }],
    exchangePolicyRules: [{
      ruleId: "stripe-prod",
      secretName: "stripe.api_key.prod",
      requesterIds: ["agent:crm-bot"],
      fulfillerIds: ["agent:payment-bot"]
    }]
  });
}

describePg("billing routes", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set for PostgreSQL integration tests");
    }

    originalUserJwtSecret = process.env.SPS_USER_JWT_SECRET;
    originalAgentJwtSecret = process.env.SPS_AGENT_JWT_SECRET;
    originalHostedMode = process.env.SPS_HOSTED_MODE;
    originalPriceId = process.env.SPS_STRIPE_STANDARD_PRICE_ID;
    originalWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    process.env.SPS_USER_JWT_SECRET = "test-user-jwt-secret";
    process.env.SPS_AGENT_JWT_SECRET = "test-agent-jwt-secret";
    process.env.SPS_HOSTED_MODE = "1";
    process.env.SPS_STRIPE_STANDARD_PRICE_ID = "price_standard_test";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    adminPool = createDbPool({
      connectionString: process.env.DATABASE_URL,
      max: 1
    });
  });

  afterAll(async () => {
    process.env.SPS_USER_JWT_SECRET = originalUserJwtSecret;
    process.env.SPS_AGENT_JWT_SECRET = originalAgentJwtSecret;
    process.env.SPS_HOSTED_MODE = originalHostedMode;
    process.env.SPS_STRIPE_STANDARD_PRICE_ID = originalPriceId;
    process.env.STRIPE_WEBHOOK_SECRET = originalWebhookSecret;
    await adminPool?.end();
    adminPool = null;
  });

  it("creates checkout sessions, upgrades on webhook, and downgrades when the subscription is deleted", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const stripeMock = createStripeMock();
      const provider = createBillingProvider(stripeMock.stripeClient);
      const app = await createBillingApp(pool, provider);
      const owner = await registerOwner(app, "billing-owner");
      await verifyOwner(app, pool, "billing-owner@example.com");

      const checkoutResponse = await app.inject({
        method: "POST",
        url: "/api/v2/billing/checkout",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });

      expect(checkoutResponse.statusCode).toBe(200);
      expect(checkoutResponse.json()).toMatchObject({
        checkout_url: "https://checkout.stripe.test/session/cs_test_123",
        billing: {
          tier: "free",
          billing_provider: "stripe",
          provider_customer_id: "cus_test_123",
          subscription_status: "none"
        }
      });

      stripeMock.setEvent(checkoutCompletedEvent(owner.user.workspace_id));
      const completedWebhook = await app.inject({
        method: "POST",
        url: "/api/v2/webhook/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "sig_test"
        },
        payload: JSON.stringify({ ok: true })
      });

      expect(completedWebhook.statusCode).toBe(200);
      expect(completedWebhook.json()).toMatchObject({
        billing: {
          tier: "standard",
          billing_provider: "stripe",
          provider_customer_id: "cus_test_123",
          provider_subscription_id: "sub_test_123",
          subscription_status: "active"
        }
      });

      const requesterJwt = await issueHostedAgentToken(owner.user.workspace_id, "agent:crm-bot");
      const exchangeResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterJwt}`
        },
        payload: {
          public_key: "cHVi",
          secret_name: "stripe.api_key.prod",
          purpose: "billing upgrade validation",
          fulfiller_hint: "agent:payment-bot"
        }
      });
      expect(exchangeResponse.statusCode).toBe(201);

      stripeMock.setEvent(subscriptionDeletedEvent());
      const deletedWebhook = await app.inject({
        method: "POST",
        url: "/api/v2/webhook/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "sig_test"
        },
        payload: JSON.stringify({ ok: true })
      });

      expect(deletedWebhook.statusCode).toBe(200);
      expect(deletedWebhook.json()).toMatchObject({
        billing: {
          tier: "free",
          subscription_status: "canceled"
        }
      });

      const freeTierExchangeResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterJwt}`
        },
        payload: {
          public_key: "cHVi",
          secret_name: "stripe.api_key.prod",
          purpose: "downgraded workspace should be blocked",
          fulfiller_hint: "agent:payment-bot"
        }
      });
      expect(freeTierExchangeResponse.statusCode).toBe(403);
      expect(freeTierExchangeResponse.json()).toEqual({
        error: "Exchange is not available on this workspace tier",
        code: "feature_not_available"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("rejects duplicate billing provider references across workspaces", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const stripeMock = createStripeMock();
      const provider = createBillingProvider(stripeMock.stripeClient);
      const app = await createBillingApp(pool, provider);
      const ownerA = await registerOwner(app, "billing-a");
      const ownerB = await registerOwner(app, "billing-b");

      stripeMock.setEvent(checkoutCompletedEvent(ownerA.user.workspace_id, "cus_dup", "sub_dup"));
      const firstWebhook = await app.inject({
        method: "POST",
        url: "/api/v2/webhook/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "sig_test"
        },
        payload: JSON.stringify({ ok: true })
      });
      expect(firstWebhook.statusCode).toBe(200);

      stripeMock.setEvent(checkoutCompletedEvent(ownerB.user.workspace_id, "cus_dup", "sub_dup"));
      const duplicateWebhook = await app.inject({
        method: "POST",
        url: "/api/v2/webhook/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "sig_test"
        },
        payload: JSON.stringify({ ok: true })
      });

      expect(duplicateWebhook.statusCode).toBe(409);
      expect(duplicateWebhook.json()).toEqual({
        error: "Billing provider reference already belongs to another workspace",
        code: "billing_conflict"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("rejects invalid webhook signatures", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const stripeMock = createStripeMock();
      vi.mocked(stripeMock.stripeClient.webhooks.constructEvent).mockImplementation(() => {
        throw new Error("invalid signature");
      });
      const provider = createBillingProvider(stripeMock.stripeClient);
      const app = await createBillingApp(pool, provider);

      const response = await app.inject({
        method: "POST",
        url: "/api/v2/webhook/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "sig_invalid"
        },
        payload: JSON.stringify({ ok: false })
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Invalid Stripe signature",
        code: "invalid_stripe_signature"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("enforces the free-tier secret request quota", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const stripeMock = createStripeMock();
      const provider = createBillingProvider(stripeMock.stripeClient);
      const app = await createBillingApp(pool, provider);
      const owner = await registerOwner(app, "quota-owner");
      const agentJwt = await issueHostedAgentToken(owner.user.workspace_id, "agent:quota-bot");

      let responseStatus = 0;
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v2/secret/request",
          headers: {
            authorization: `Bearer ${agentJwt}`
          },
          payload: {
            public_key: "cHVi",
            description: `Quota attempt ${attempt + 1}`
          }
        });
        responseStatus = response.statusCode;
        if (attempt < 10) {
          expect(response.statusCode).toBe(201);
        }
      }

      expect(responseStatus).toBe(429);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("enforces the free-tier enrolled-agent cap", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const stripeMock = createStripeMock();
      const provider = createBillingProvider(stripeMock.stripeClient);
      const app = await createBillingApp(pool, provider);
      const owner = await registerOwner(app, "agent-cap-owner");
      await verifyOwner(app, pool, "agent-cap-owner@example.com");

      for (let index = 0; index < 5; index += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v2/agents",
          headers: {
            authorization: `Bearer ${owner.access_token}`
          },
          payload: {
            agent_id: `agent-${index + 1}`
          }
        });
        expect(response.statusCode).toBe(201);
      }

      const cappedResponse = await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          agent_id: "agent-6"
        }
      });

      expect(cappedResponse.statusCode).toBe(429);
      expect(cappedResponse.json()).toEqual({
        error: "Agent quota exceeded",
        code: "quota_exceeded",
        limit: 5,
        used: 5
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("creates billing portal session for standard-tier workspace", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const stripeMock = createStripeMock();
      const provider = createBillingProvider(stripeMock.stripeClient);
      const app = await createBillingApp(pool, provider);
      const owner = await registerOwner(app, "portal-owner");
      await verifyOwner(app, pool, "portal-owner@example.com");

      // First upgrade the workspace via checkout + webhook
      await app.inject({
        method: "POST",
        url: "/api/v2/billing/checkout",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });

      stripeMock.setEvent(checkoutCompletedEvent(owner.user.workspace_id));
      await app.inject({
        method: "POST",
        url: "/api/v2/webhook/stripe",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "sig_test"
        },
        payload: JSON.stringify({ ok: true })
      });

      // Now request a portal session
      const portalResponse = await app.inject({
        method: "POST",
        url: "/api/v2/billing/portal",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });

      expect(portalResponse.statusCode).toBe(200);
      expect(portalResponse.json()).toEqual({
        portal_url: "https://billing.stripe.test/portal/bps_test_123"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("rejects billing portal for workspace without billing customer", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const stripeMock = createStripeMock();
      const provider = createBillingProvider(stripeMock.stripeClient);
      const app = await createBillingApp(pool, provider);
      const owner = await registerOwner(app, "free-portal");

      const portalResponse = await app.inject({
        method: "POST",
        url: "/api/v2/billing/portal",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });

      expect(portalResponse.statusCode).toBe(400);
      expect(portalResponse.json()).toEqual({
        error: "No billing subscription found. Please subscribe first.",
        code: "no_billing_customer"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("returns dashboard summary metrics for workspace admins", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const stripeMock = createStripeMock();
      const provider = createBillingProvider(stripeMock.stripeClient);
      const app = await createBillingApp(pool, provider);
      const owner = await registerOwner(app, "summary-owner");
      await verifyOwner(app, pool, "summary-owner@example.com");

      const enrollResponse = await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          agent_id: "agent:summary-bot",
          display_name: "Summary Bot"
        }
      });
      expect(enrollResponse.statusCode).toBe(201);

      const agentJwt = await issueHostedAgentToken(owner.user.workspace_id, "agent:summary-bot");
      const secretRequestResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/request",
        headers: {
          authorization: `Bearer ${agentJwt}`
        },
        payload: {
          public_key: "cHVi",
          description: "Summary quota sample"
        }
      });
      expect(secretRequestResponse.statusCode).toBe(201);

      const summaryResponse = await app.inject({
        method: "GET",
        url: "/api/v2/dashboard/summary",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });

      expect(summaryResponse.statusCode).toBe(200);
      expect(summaryResponse.json()).toMatchObject({
        workspace: {
          id: owner.user.workspace_id,
          slug: "summary-owner-space",
          display_name: "summary-owner Space",
          tier: "free",
          status: "active"
        },
        billing: {
          workspace_id: owner.user.workspace_id,
          workspace_slug: "summary-owner-space",
          tier: "free",
          status: "active",
          billing_provider: null,
          provider_customer_id: null,
          provider_subscription_id: null,
          subscription_status: "none"
        },
        counts: {
          active_agents: 1,
          active_members: 1
        },
        quota: {
          secret_requests: {
            used: 1,
            limit: 10
          },
          agents: {
            used: 1,
            limit: 5
          },
          members: {
            used: 1,
            limit: 1
          },
          a2a_exchange_available: false
        }
      });
      expect(summaryResponse.json().quota.secret_requests.reset_at).toEqual(expect.any(Number));

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("blocks non-admin users from dashboard summary", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const stripeMock = createStripeMock();
      const provider = createBillingProvider(stripeMock.stripeClient);
      const app = await createBillingApp(pool, provider);
      await registerOwner(app, "summary-operator");
      await verifyOwner(app, pool, "summary-operator@example.com");
      await pool.query(
        "UPDATE users SET role = 'workspace_operator', updated_at = now() WHERE email = $1",
        ["summary-operator@example.com"]
      );
      const operator = await login(app, "summary-operator@example.com", "Password123!");

      const response = await app.inject({
        method: "GET",
        url: "/api/v2/dashboard/summary",
        headers: {
          authorization: `Bearer ${operator.access_token}`
        }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: "Insufficient role"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("rejects billing portal when the stored provider does not match the active provider", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const stripeMock = createStripeMock();
      const provider = createBillingProvider(stripeMock.stripeClient);
      const app = await createBillingApp(pool, provider);
      const owner = await registerOwner(app, "portal-mismatch");

      await pool.query(
        `
          UPDATE workspaces
          SET billing_provider = 'x402',
              billing_provider_customer_id = 'cust_x402_demo',
              updated_at = now()
          WHERE id = $1
        `,
        [owner.user.workspace_id]
      );

      const portalResponse = await app.inject({
        method: "POST",
        url: "/api/v2/billing/portal",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });

      expect(portalResponse.statusCode).toBe(409);
      expect(portalResponse.json()).toEqual({
        error: "Workspace billing is managed by a different provider",
        code: "billing_provider_mismatch"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
