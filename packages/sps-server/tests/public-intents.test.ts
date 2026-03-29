import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/index.js";
import type { X402PaymentRequired, X402Provider, X402SettleInput, X402VerifyInput } from "../src/services/x402.js";

const runPgIntegration = process.env.SPS_PG_INTEGRATION === "1";
const describePg = runPgIntegration ? describe : describe.skip;
const migrationsDir = new URL("../src/db/migrations/", import.meta.url);

let adminPool: Pool | null = null;

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

  const schema = randomSchema("public_intents");
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

async function registerOwner(app: Awaited<ReturnType<typeof buildApp>>, pool: Pool | null, identity: string) {
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
  const body = response.json() as {
    access_token: string;
    user: { id: string; workspace_id: string };
  };

  if (pool) {
    await pool.query("UPDATE workspaces SET tier = 'standard' WHERE id = $1", [body.user.workspace_id]);
  }

  return body;
}

async function verifyOwner(app: Awaited<ReturnType<typeof buildApp>>, pool: Pool, email: string): Promise<void> {
  await pool.query("UPDATE users SET email_verified = true WHERE email = $1", [email]);
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, email: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    payload: {
      email,
      password
    }
  });

  expect(response.statusCode).toBe(200);
  return response.json() as { access_token: string };
}

async function changePassword(
  app: Awaited<ReturnType<typeof buildApp>>,
  accessToken: string,
  currentPassword: string,
  newPassword: string
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/change-password",
    headers: {
      authorization: `Bearer ${accessToken}`
    },
    payload: {
      current_password: currentPassword,
      next_password: newPassword
    }
  });

  expect(response.statusCode).toBe(200);
  return (response.json() as { access_token: string }).access_token;
}

async function createMemberAndLogin(
  app: Awaited<ReturnType<typeof buildApp>>,
  ownerToken: string,
  email: string,
  role: "workspace_operator" | "workspace_viewer",
  temporaryPassword: string,
  nextPassword: string
) {
  const createResponse = await app.inject({
    method: "POST",
    url: "/api/v2/members",
    headers: {
      authorization: `Bearer ${ownerToken}`
    },
    payload: {
      email,
      temporary_password: temporaryPassword,
      role
    }
  });

  expect(createResponse.statusCode).toBe(201);
  const loginResponse = await login(app, email, temporaryPassword);
  const accessToken = await changePassword(app, loginResponse.access_token, temporaryPassword, nextPassword);
  return { access_token: accessToken };
}

async function enrollAgent(
  app: Awaited<ReturnType<typeof buildApp>>,
  accessToken: string,
  agentId: string,
  displayName?: string
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/agents",
    headers: {
      authorization: `Bearer ${accessToken}`
    },
    payload: displayName ? { agent_id: agentId, display_name: displayName } : { agent_id: agentId }
  });

  expect(response.statusCode).toBe(201);
  return response.json() as {
    bootstrap_api_key: string;
    agent: { agent_id: string; status: string };
  };
}

async function mintAgentToken(
  app: Awaited<ReturnType<typeof buildApp>>,
  apiKey: string,
  ipAddress: string
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/agents/token",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "x-forwarded-for": ipAddress
    }
  });

  expect(response.statusCode).toBe(200);
  return response.json() as { access_token: string };
}

async function createOffer(
  app: Awaited<ReturnType<typeof buildApp>>,
  accessToken: string,
  payload: Partial<{
    offer_label: string;
    delivery_mode: "human" | "agent" | "either";
    payment_policy: "free" | "always_x402" | "quota_then_x402";
    price_usd_cents: number;
    included_free_uses: number;
    secret_name: string;
    allowed_fulfiller_id: string;
    require_approval: boolean;
    ttl_seconds: number;
    max_uses: number;
  }> = {}
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/public/offers",
    headers: {
      authorization: `Bearer ${accessToken}`
    },
    payload: {
      offer_label: "Stripe handoff",
      delivery_mode: "human",
      payment_policy: "always_x402",
      price_usd_cents: 5,
      secret_name: "stripe.api_key.prod",
      ttl_seconds: 300,
      ...payload
    }
  });

  expect(response.statusCode).toBe(201);
  return response.json() as {
    offer: { id: string; status: string };
    offer_token: string;
  };
}

function parseFulfillUrl(fulfillUrl: string): {
  requestId: string;
  metadataSig: string;
  submitSig: string;
} {
  const url = new URL(fulfillUrl);
  const requestId = url.searchParams.get("id");
  const metadataSig = url.searchParams.get("metadata_sig");
  const submitSig = url.searchParams.get("submit_sig");

  expect(requestId).toEqual(expect.any(String));
  expect(metadataSig).toEqual(expect.any(String));
  expect(submitSig).toEqual(expect.any(String));

  return {
    requestId: requestId!,
    metadataSig: metadataSig!,
    submitSig: submitSig!
  };
}

function decodePaymentRequired(headerValue: string): X402PaymentRequired {
  return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")) as X402PaymentRequired;
}

function encodePaymentSignature(params: {
  paymentId: string;
  paymentRequired: X402PaymentRequired;
  payer?: string;
}): string {
  const option = params.paymentRequired.accepts[0];
  return JSON.stringify({
    x402Version: 2,
    resource: params.paymentRequired.resource,
    accepted: option,
    payload: {
      paymentId: params.paymentId,
      payer: params.payer ?? "guest-agent",
      signature: "guest-test-signature"
    },
    extensions: {
      blindpass: {
        paymentId: params.paymentId
      }
    }
  });
}

class TestX402Provider implements X402Provider {
  readonly name = "test-x402";
  readonly verifyCalls: X402VerifyInput[] = [];
  readonly settleCalls: X402SettleInput[] = [];
  verifyResult: { valid: boolean; payer?: string | null } = { valid: true, payer: "guest-agent" };
  settleError: Error | null = null;

  async verifyPayment(input: X402VerifyInput) {
    this.verifyCalls.push(input);
    return {
      valid: this.verifyResult.valid,
      payer: this.verifyResult.payer ?? (
        typeof input.paymentPayload.payload.payer === "string" ? input.paymentPayload.payload.payer : "guest-agent"
      ),
      failureReason: this.verifyResult.valid ? null : "forced_test_failure"
    };
  }

  async settlePayment(input: X402SettleInput) {
    this.settleCalls.push(input);
    if (this.settleError) {
      throw this.settleError;
    }
    return {
      status: "settled" as const,
      txHash: "0xguestpayment"
    };
  }
}

async function createPaymentChallenge(
  app: Awaited<ReturnType<typeof buildApp>>,
  payload: {
    offer_token: string;
    public_key: string;
    purpose: string;
    actor_type?: "guest_agent" | "guest_human";
    requester_label?: string;
  },
  ip = "198.51.100.44"
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/public/intents",
    headers: {
      "x-forwarded-for": ip
    },
    payload
  });

  expect(response.statusCode).toBe(402);
  const paymentRequiredHeader = response.headers["payment-required"];
  expect(paymentRequiredHeader).toEqual(expect.any(String));
  return {
    response,
    paymentRequired: decodePaymentRequired(paymentRequiredHeader as string)
  };
}

async function submitPaidIntent(
  app: Awaited<ReturnType<typeof buildApp>>,
  payload: {
    offer_token: string;
    public_key: string;
    purpose: string;
    actor_type?: "guest_agent" | "guest_human";
    requester_label?: string;
  },
  paymentRequired: X402PaymentRequired,
  paymentId: string,
  ip = "198.51.100.44"
) {
  return app.inject({
    method: "POST",
    url: "/api/v2/public/intents",
    headers: {
      "x-forwarded-for": ip,
      "payment-identifier": paymentId,
      "payment-signature": encodePaymentSignature({
        paymentId,
        paymentRequired
      })
    },
    payload
  });
}

async function activatePaidHumanIntent(
  app: Awaited<ReturnType<typeof buildApp>>,
  payload: {
    offer_token: string;
    public_key: string;
    purpose: string;
    actor_type?: "guest_agent" | "guest_human";
    requester_label?: string;
  },
  paymentId: string,
  ip = "198.51.100.44"
) {
  const { paymentRequired } = await createPaymentChallenge(app, payload, ip);
  const activationResponse = await submitPaidIntent(app, payload, paymentRequired, paymentId, ip);
  expect(activationResponse.statusCode).toBe(201);
  return activationResponse.json() as {
    intent: {
      intent_id: string;
      status: string;
      status_token: string;
      request_id: string | null;
    };
    request_id: string;
    fulfill_url: string;
    guest_access_token: string;
  };
}

async function activatePaidAgentIntent(
  app: Awaited<ReturnType<typeof buildApp>>,
  payload: {
    offer_token: string;
    public_key: string;
    purpose: string;
    actor_type?: "guest_agent" | "guest_human";
    requester_label?: string;
  },
  paymentId: string,
  ip = "198.51.100.44"
) {
  const { paymentRequired } = await createPaymentChallenge(app, payload, ip);
  const activationResponse = await submitPaidIntent(app, payload, paymentRequired, paymentId, ip);
  expect(activationResponse.statusCode).toBe(201);
  return activationResponse.json() as {
    intent: {
      intent_id: string;
      status: string;
      status_token: string;
      exchange_id: string | null;
    };
    exchange_id: string;
    fulfillment_token: string;
    guest_access_token: string;
  };
}

async function withTemporaryEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describePg("Phase 3C public offers and guest intents", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set for PostgreSQL integration tests");
    }

    process.env.SPS_USER_JWT_SECRET = "test-user-jwt-secret";
    process.env.SPS_AGENT_JWT_SECRET = "test-agent-jwt-secret";
    process.env.SPS_HOSTED_MODE = "1";
    process.env.SPS_MEMBER_LIMIT_FREE = "10";
    process.env.SPS_X402_ENABLED = "1";
    process.env.SPS_X402_FACILITATOR_URL = "https://facilitator.example.test";
    process.env.SPS_SECRET_REGISTRY_JSON = JSON.stringify([
      { secretName: "stripe.api_key.prod", classification: "finance" },
      { secretName: "restricted.secret", classification: "sensitive" }
    ]);
    process.env.SPS_EXCHANGE_POLICY_JSON = JSON.stringify([
      { ruleId: "allow-stripe", secretName: "stripe.api_key.prod", mode: "allow" },
      { ruleId: "allow-restricted", secretName: "restricted.secret", mode: "allow" }
    ]);
    adminPool = createDbPool({
      connectionString: process.env.DATABASE_URL,
      max: 1
    });
  });

  afterAll(async () => {
    await adminPool?.end();
    adminPool = null;
  });

  it("creates a human-delivery public offer and stores only the token hash", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
      const owner = await registerOwner(app, pool, "public-offer-admin");
      await verifyOwner(app, pool, "public-offer-admin@example.com");

      const response = await app.inject({
        method: "POST",
        url: "/api/v2/public/offers",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          delivery_mode: "human",
          payment_policy: "quota_then_x402",
          included_free_uses: 1,
          price_usd_cents: 5,
          secret_name: "stripe.api_key.prod",
          ttl_seconds: 300
        }
      });

      expect(response.statusCode).toBe(201);
      const created = response.json() as {
        offer: { id: string; payment_policy: string; included_free_uses: number };
        offer_token: string;
      };
      expect(created.offer).toMatchObject({
        payment_policy: "quota_then_x402",
        included_free_uses: 1
      });
      expect(created.offer_token).toEqual(expect.stringMatching(/^po_/));

      const stored = await pool.query<{ token_hash: string }>(
        "SELECT token_hash FROM public_offers WHERE id = $1",
        [created.offer.id]
      );
      expect(stored.rows[0]?.token_hash).toEqual(expect.any(String));
      expect(stored.rows[0]?.token_hash).not.toBe(created.offer_token);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("allows operators to create and revoke offers", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });
      const owner = await registerOwner(app, pool, "public-offer-operator");
      await verifyOwner(app, pool, "public-offer-operator@example.com");
      const operator = await createMemberAndLogin(
        app,
        owner.access_token,
        "operator@example.com",
        "workspace_operator",
        "OperatorTemp123!",
        "OperatorNew123!"
      );

      const created = await createOffer(app, operator.access_token);

      const revokeResponse = await app.inject({
        method: "POST",
        url: `/api/v2/public/offers/${created.offer.id}/revoke`,
        headers: {
          authorization: `Bearer ${operator.access_token}`
        }
      });

      expect(revokeResponse.statusCode).toBe(200);
      expect(revokeResponse.json()).toMatchObject({
        offer: {
          id: created.offer.id,
          status: "revoked"
        }
      });

      const intentResponse = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        payload: {
          offer_token: created.offer_token,
          public_key: "QUJDRA==",
          purpose: "Need a one-time secret handoff"
        }
      });

      expect(intentResponse.statusCode).toBe(410);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("keeps viewers denied on offer management", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });
      const owner = await registerOwner(app, pool, "public-offer-viewer");
      await verifyOwner(app, pool, "public-offer-viewer@example.com");
      const viewer = await createMemberAndLogin(
        app,
        owner.access_token,
        "viewer@example.com",
        "workspace_viewer",
        "ViewerTemp123!",
        "ViewerNew123!"
      );

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v2/public/offers",
        headers: {
          authorization: `Bearer ${viewer.access_token}`
        }
      });
      expect(listResponse.statusCode).toBe(200);

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v2/public/offers",
        headers: {
          authorization: `Bearer ${viewer.access_token}`
        },
        payload: {
          delivery_mode: "human",
          payment_policy: "always_x402",
          price_usd_cents: 5,
          secret_name: "stripe.api_key.prod",
          ttl_seconds: 300
        }
      });
      expect(createResponse.statusCode).toBe(403);

      const ownerOffer = await createOffer(app, owner.access_token);
      const revokeResponse = await app.inject({
        method: "POST",
        url: `/api/v2/public/offers/${ownerOffer.offer.id}/revoke`,
        headers: {
          authorization: `Bearer ${viewer.access_token}`
        }
      });
      expect(revokeResponse.statusCode).toBe(403);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("lets viewers inspect guest offers and guest intent support details without token leakage", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-support-viewer");
      await verifyOwner(app, pool, "guest-support-viewer@example.com");
      const viewer = await createMemberAndLogin(
        app,
        owner.access_token,
        "support-viewer@example.com",
        "workspace_viewer",
        "ViewerTemp123!",
        "ViewerNew123!"
      );
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5
      });

      const activated = await activatePaidHumanIntent(app, {
        offer_token: created.offer_token,
        public_key: "QUJDRA==",
        purpose: "viewer support"
      }, "viewer-support-pay-1", "198.51.100.68");

      const offersResponse = await app.inject({
        method: "GET",
        url: "/api/v2/public/offers",
        headers: {
          authorization: `Bearer ${viewer.access_token}`
        }
      });
      expect(offersResponse.statusCode).toBe(200);
      expect(offersResponse.json()).toMatchObject({
        offers: [
          expect.objectContaining({
            id: created.offer.id,
            payment_policy: "always_x402"
          })
        ]
      });

      const intentsResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/admin?offer_id=${encodeURIComponent(created.offer.id)}`,
        headers: {
          authorization: `Bearer ${viewer.access_token}`
        }
      });
      expect(intentsResponse.statusCode).toBe(200);
      const listPayload = intentsResponse.json() as {
        intents: Array<Record<string, unknown>>;
      };
      expect(listPayload.intents).toHaveLength(1);
      expect(listPayload.intents[0]).toMatchObject({
        id: activated.intent.intent_id,
        offer_id: created.offer.id,
        effective_status: "activated",
        latest_payment: expect.objectContaining({
          status: "settled"
        }),
        request_state: expect.objectContaining({
          status: "pending"
        })
      });
      expect(listPayload.intents[0]).not.toHaveProperty("guest_access_token");
      expect(listPayload.intents[0]).not.toHaveProperty("status_token");
      expect(listPayload.intents[0]).not.toHaveProperty("fulfill_url");

      const detailResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/admin/${activated.intent.intent_id}`,
        headers: {
          authorization: `Bearer ${viewer.access_token}`
        }
      });
      expect(detailResponse.statusCode).toBe(200);
      const detailPayload = detailResponse.json() as {
        intent: Record<string, unknown>;
      };
      expect(detailPayload.intent).toMatchObject({
        id: activated.intent.intent_id,
        purpose: "viewer support",
        resolved_secret_name: "stripe.api_key.prod"
      });
      expect(detailPayload.intent).not.toHaveProperty("guest_access_token");
      expect(detailPayload.intent).not.toHaveProperty("status_token");
      expect(detailPayload.intent).not.toHaveProperty("fulfill_url");

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("enforces offer expiry before returning a payment challenge", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });
      const owner = await registerOwner(app, pool, "public-offer-expiry");
      await verifyOwner(app, pool, "public-offer-expiry@example.com");
      const created = await createOffer(app, owner.access_token, { ttl_seconds: 1 });

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const response = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        payload: {
          offer_token: created.offer_token,
          public_key: "QUJDRA==",
          purpose: "expired offer"
        }
      });

      expect(response.statusCode).toBe(410);
      expect(response.headers["payment-required"]).toBeUndefined();

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("returns minimally revealing public intent status", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });
      const owner = await registerOwner(app, pool, "guest-status");
      await verifyOwner(app, pool, "guest-status@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5
      });

      const intentResponse = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: {
          "x-forwarded-for": "203.0.113.99"
        },
        payload: {
          offer_token: created.offer_token,
          public_key: "QUJDRA==",
          purpose: "status handle"
        }
      });

      expect(intentResponse.statusCode).toBe(402);
      const intent = (intentResponse.json() as { intent: { intent_id: string; status_token: string } }).intent;
      const statusResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${intent.intent_id}/status?status_token=${encodeURIComponent(intent.status_token)}`
      });

      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json()).toMatchObject({
        intent_id: intent.intent_id,
        status: "payment_required",
        payment_required: true
      });
      expect(statusResponse.json()).not.toHaveProperty("workspace_id");
      expect(statusResponse.json()).not.toHaveProperty("secret_name");
      expect(statusResponse.json()).not.toHaveProperty("requester_label");

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("enforces one active unpaid intent per guest subject by resuming the existing intent", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
      const owner = await registerOwner(app, pool, "guest-dedupe");
      await verifyOwner(app, pool, "guest-dedupe@example.com");
      const created = await createOffer(app, owner.access_token);

      const first = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: {
          "x-forwarded-for": "198.51.100.10"
        },
        payload: {
          offer_token: created.offer_token,
          public_key: "QUJDRA==",
          purpose: "dedupe test"
        }
      });

      const second = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: {
          "x-forwarded-for": "198.51.100.10"
        },
        payload: {
          offer_token: created.offer_token,
          public_key: "QUJDRA==",
          purpose: "dedupe test"
        }
      });

      expect(first.statusCode).toBe(402);
      expect(second.statusCode).toBe(402);
      const firstIntent = (first.json() as { intent: { intent_id: string; status_token: string } }).intent;
      const secondIntent = (second.json() as { intent: { intent_id: string; status_token: string } }).intent;
      expect(secondIntent.intent_id).toBe(firstIntent.intent_id);
      expect(secondIntent.status_token).toBe(firstIntent.status_token);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("switches quota_then_x402 from free activation to paid activation", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });
      const owner = await registerOwner(app, pool, "guest-quota");
      await verifyOwner(app, pool, "guest-quota@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "quota_then_x402",
        included_free_uses: 1,
        price_usd_cents: 5
      });

      const freeIntent = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        payload: {
          offer_token: created.offer_token,
          public_key: "QUJDRA==",
          purpose: "first free use"
        }
      });

      expect(freeIntent.statusCode).toBe(201);
      expect(freeIntent.headers["payment-required"]).toBeUndefined();
      expect(freeIntent.json()).toMatchObject({
        intent: {
          status: "activated",
          payment_required: false
        }
      });

      const paidIntent = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        payload: {
          offer_token: created.offer_token,
          public_key: "RkZGRg==",
          purpose: "second use should be paid"
        }
      });

      expect(paidIntent.statusCode).toBe(402);
      expect(paidIntent.headers["payment-required"]).toEqual(expect.any(String));

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("keeps approval-gated intents non-payable until approved", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });
      const owner = await registerOwner(app, pool, "guest-approval");
      await verifyOwner(app, pool, "guest-approval@example.com");
      const created = await createOffer(app, owner.access_token, {
        require_approval: true
      });

      const intentResponse = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        payload: {
          offer_token: created.offer_token,
          public_key: "QUJDRA==",
          purpose: "approval gate"
        }
      });

      expect(intentResponse.statusCode).toBe(202);
      expect(intentResponse.headers["payment-required"]).toBeUndefined();
      expect(intentResponse.json()).toMatchObject({
        intent: {
          status: "pending_approval",
          payment_required: false
        }
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("lets an operator approve a pending guest intent and makes the resume payable", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });
      const owner = await registerOwner(app, pool, "guest-approval-operator");
      await verifyOwner(app, pool, "guest-approval-operator@example.com");
      const operator = await createMemberAndLogin(
        app,
        owner.access_token,
        "operator@example.com",
        "workspace_operator",
        "OperatorTemp123!",
        "OperatorNew123!"
      );
      const created = await createOffer(app, owner.access_token, {
        require_approval: true
      });

      const intentResponse = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: {
          "x-forwarded-for": "198.51.100.12"
        },
        payload: {
          offer_token: created.offer_token,
          public_key: "QUJDRA==",
          purpose: "approve me"
        }
      });
      expect(intentResponse.statusCode).toBe(202);
      const intentId = (intentResponse.json() as { intent: { intent_id: string } }).intent.intent_id;

      const approveResponse = await app.inject({
        method: "POST",
        url: `/api/v2/public/intents/${intentId}/approve`,
        headers: {
          authorization: `Bearer ${operator.access_token}`
        }
      });
      expect(approveResponse.statusCode).toBe(200);
      expect(approveResponse.json()).toMatchObject({
        intent: {
          intent_id: intentId,
          approval_status: "approved"
        }
      });

      const resumed = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: {
          "x-forwarded-for": "198.51.100.12"
        },
        payload: {
          offer_token: created.offer_token,
          public_key: "QUJDRA==",
          purpose: "approve me"
        }
      });

      expect(resumed.statusCode).toBe(402);
      expect(resumed.headers["payment-required"]).toEqual(expect.any(String));

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("keeps rejected intents non-payable on later retries", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });
      const owner = await registerOwner(app, pool, "guest-approval-reject");
      await verifyOwner(app, pool, "guest-approval-reject@example.com");
      const operator = await createMemberAndLogin(
        app,
        owner.access_token,
        "operator@example.com",
        "workspace_operator",
        "OperatorTemp123!",
        "OperatorNew123!"
      );
      const created = await createOffer(app, owner.access_token, {
        require_approval: true
      });

      const intentResponse = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: {
          "x-forwarded-for": "198.51.100.13"
        },
        payload: {
          offer_token: created.offer_token,
          public_key: "QUJDRA==",
          purpose: "reject me"
        }
      });
      expect(intentResponse.statusCode).toBe(202);
      const intentId = (intentResponse.json() as { intent: { intent_id: string } }).intent.intent_id;

      const rejectResponse = await app.inject({
        method: "POST",
        url: `/api/v2/public/intents/${intentId}/reject`,
        headers: {
          authorization: `Bearer ${operator.access_token}`
        }
      });
      expect(rejectResponse.statusCode).toBe(200);
      expect(rejectResponse.json()).toMatchObject({
        intent: {
          intent_id: intentId,
          approval_status: "rejected"
        }
      });

      const resumed = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: {
          "x-forwarded-for": "198.51.100.13"
        },
        payload: {
          offer_token: created.offer_token,
          public_key: "QUJDRA==",
          purpose: "reject me"
        }
      });

      expect(resumed.statusCode).toBe(403);
      expect(resumed.headers["payment-required"]).toBeUndefined();
      expect(resumed.json()).toMatchObject({
        code: "guest_intent_rejected"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("returns a payable x402 challenge with the expected quote details", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
      const owner = await registerOwner(app, pool, "guest-payment-quote");
      await verifyOwner(app, pool, "guest-payment-quote@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: {
          "x-forwarded-for": "198.51.100.60"
        },
        payload: {
          offer_token: created.offer_token,
          public_key: "QUJDRA==",
          purpose: "quote details"
        }
      });

      expect(response.statusCode).toBe(402);
      const paymentRequired = decodePaymentRequired(response.headers["payment-required"] as string);
      expect(paymentRequired).toMatchObject({
        x402Version: 2,
        metadata: {
          quoted_amount_cents: 5,
          quoted_currency: "USD",
          quoted_asset_symbol: "USDC",
          quoted_asset_amount: "0.05"
        }
      });
      expect(paymentRequired.accepts[0]).toMatchObject({
        scheme: "exact",
        network: "eip155:84532"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("returns cached success on an idempotent paid retry with the same payment identifier", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-payment-idempotent");
      await verifyOwner(app, pool, "guest-payment-idempotent@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5
      });

      const payload = {
        offer_token: created.offer_token,
        public_key: "QUJDRA==",
        purpose: "idempotent retry"
      };
      const { paymentRequired } = await createPaymentChallenge(app, payload, "198.51.100.61");

      const firstResponse = await submitPaidIntent(app, payload, paymentRequired, "idempotent-pay-1", "198.51.100.61");
      expect(firstResponse.statusCode).toBe(201);
      const firstBody = firstResponse.json();

      const secondResponse = await submitPaidIntent(app, payload, paymentRequired, "idempotent-pay-1", "198.51.100.61");
      expect(secondResponse.statusCode).toBe(201);
      expect(secondResponse.json()).toEqual(firstBody);
      expect(x402Provider.verifyCalls).toHaveLength(1);
      expect(x402Provider.settleCalls).toHaveLength(1);

      const paymentRows = await pool.query<{ status: string }>(
        "SELECT status FROM guest_payments WHERE payment_id = $1",
        ["idempotent-pay-1"]
      );
      expect(paymentRows.rows).toHaveLength(1);
      expect(paymentRows.rows[0]?.status).toBe("settled");

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("rejects payment identifier reuse when the request body changes", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-payment-conflict");
      await verifyOwner(app, pool, "guest-payment-conflict@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5
      });

      const firstPayload = {
        offer_token: created.offer_token,
        public_key: "QUJDRA==",
        purpose: "original body"
      };
      const { paymentRequired } = await createPaymentChallenge(app, firstPayload, "198.51.100.62");

      const firstResponse = await submitPaidIntent(app, firstPayload, paymentRequired, "conflict-pay-1", "198.51.100.62");
      expect(firstResponse.statusCode).toBe(201);

      const conflictResponse = await submitPaidIntent(app, {
        ...firstPayload,
        purpose: "different body"
      }, paymentRequired, "conflict-pay-1", "198.51.100.62");
      expect(conflictResponse.statusCode).toBe(409);
      expect(conflictResponse.json()).toMatchObject({
        code: "payment_identifier_conflict"
      });
      expect(x402Provider.verifyCalls).toHaveLength(1);
      expect(x402Provider.settleCalls).toHaveLength(1);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("records a failed payment and does not create downstream request artifacts", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      x402Provider.settleError = new Error("forced settlement failure");
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-payment-failed");
      await verifyOwner(app, pool, "guest-payment-failed@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5
      });

      const payload = {
        offer_token: created.offer_token,
        public_key: "QUJDRA==",
        purpose: "failed payment"
      };
      const { paymentRequired } = await createPaymentChallenge(app, payload, "198.51.100.63");

      const response = await submitPaidIntent(app, payload, paymentRequired, "failed-pay-1", "198.51.100.63");
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({
        code: "x402_provider_error"
      });

      const paymentRows = await pool.query<{ status: string; tx_hash: string | null }>(
        `
          SELECT status, tx_hash
          FROM guest_payments
          WHERE payment_id = $1
        `,
        ["failed-pay-1"]
      );
      expect(paymentRows.rows).toHaveLength(1);
      expect(paymentRows.rows[0]).toMatchObject({
        status: "failed",
        tx_hash: null
      });

      const intentRows = await pool.query<{ status: string; request_id: string | null; exchange_id: string | null }>(
        `
          SELECT status, request_id, exchange_id
          FROM guest_intents
          WHERE offer_id = $1
            AND purpose = $2
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [created.offer.id, payload.purpose]
      );
      expect(intentRows.rows).toHaveLength(1);
      expect(intentRows.rows[0]).toMatchObject({
        status: "payment_required",
        request_id: null,
        exchange_id: null
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("rejects stale quotes without creating paid activation artifacts", async () => {
    const { pool, schema } = await createIsolatedPool();
    const previousQuoteTtl = process.env.SPS_X402_QUOTE_TTL_SECONDS;

    try {
      process.env.SPS_X402_QUOTE_TTL_SECONDS = "1";
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-payment-expired");
      await verifyOwner(app, pool, "guest-payment-expired@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5
      });

      const payload = {
        offer_token: created.offer_token,
        public_key: "QUJDRA==",
        purpose: "expired quote"
      };
      const { paymentRequired } = await createPaymentChallenge(app, payload, "198.51.100.64");

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const response = await submitPaidIntent(app, payload, paymentRequired, "expired-pay-1", "198.51.100.64");
      expect(response.statusCode).toBe(402);
      expect(response.json()).toMatchObject({
        code: "quote_expired"
      });
      expect(x402Provider.verifyCalls).toHaveLength(0);
      expect(x402Provider.settleCalls).toHaveLength(0);

      const paymentRows = await pool.query<{ status: string }>(
        "SELECT status FROM guest_payments WHERE payment_id = $1",
        ["expired-pay-1"]
      );
      expect(paymentRows.rows).toHaveLength(0);

      const intentRows = await pool.query<{ request_id: string | null; exchange_id: string | null }>(
        `
          SELECT request_id, exchange_id
          FROM guest_intents
          WHERE offer_id = $1
            AND purpose = $2
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [created.offer.id, payload.purpose]
      );
      expect(intentRows.rows).toHaveLength(1);
      expect(intentRows.rows[0]).toMatchObject({
        request_id: null,
        exchange_id: null
      });

      await app.close();
    } finally {
      if (previousQuoteTtl === undefined) {
        delete process.env.SPS_X402_QUOTE_TTL_SECONDS;
      } else {
        process.env.SPS_X402_QUOTE_TTL_SECONDS = previousQuoteTtl;
      }
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("revokes a paid guest human intent so fulfill and retrieve fail closed", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-revoke");
      await verifyOwner(app, pool, "guest-revoke@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5
      });

      const activated = await activatePaidHumanIntent(app, {
        offer_token: created.offer_token,
        public_key: "QUJDRA==",
        purpose: "revoke before fulfill"
      }, "revoke-pay-1", "198.51.100.65");

      const revokeResponse = await app.inject({
        method: "POST",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/revoke`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(revokeResponse.statusCode).toBe(200);
      expect(revokeResponse.json()).toMatchObject({
        intent: {
          intent_id: activated.intent.intent_id,
          status: "revoked"
        }
      });

      const { requestId, metadataSig, submitSig } = parseFulfillUrl(activated.fulfill_url);
      const metadataResponse = await app.inject({
        method: "GET",
        url: `/api/v2/secret/metadata/${requestId}?sig=${encodeURIComponent(metadataSig)}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(metadataResponse.statusCode).toBe(410);

      const submitResponse = await app.inject({
        method: "POST",
        url: `/api/v2/secret/submit/${requestId}?sig=${encodeURIComponent(submitSig)}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          enc: "QUJDRA==",
          ciphertext: "RUZHSA=="
        }
      });
      expect(submitResponse.statusCode).toBe(410);

      const deliveryStatus = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/delivery-status`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(deliveryStatus.statusCode).toBe(410);

      const retrieveResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/retrieve`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(retrieveResponse.statusCode).toBe(410);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("expires a paid but unfulfilled guest intent even if the request record still exists", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-expired-unfulfilled");
      await verifyOwner(app, pool, "guest-expired-unfulfilled@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5,
        ttl_seconds: 1
      });

      const activated = await activatePaidHumanIntent(app, {
        offer_token: created.offer_token,
        public_key: "QUJDRA==",
        purpose: "expire before fulfill"
      }, "expire-pay-1", "198.51.100.66");

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const { requestId, metadataSig } = parseFulfillUrl(activated.fulfill_url);
      const metadataResponse = await app.inject({
        method: "GET",
        url: `/api/v2/secret/metadata/${requestId}?sig=${encodeURIComponent(metadataSig)}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(metadataResponse.statusCode).toBe(410);

      const statusResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/status?status_token=${encodeURIComponent(activated.intent.status_token)}`
      });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json()).toMatchObject({
        intent_id: activated.intent.intent_id,
        status: "expired",
        payment_required: false
      });

      const retrieveResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/retrieve`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(retrieveResponse.statusCode).toBe(401);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("records guest audit events without leaking secret payloads or raw tokens", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-audit");
      await verifyOwner(app, pool, "guest-audit@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5
      });

      const activated = await activatePaidHumanIntent(app, {
        offer_token: created.offer_token,
        public_key: "QUJDRA==",
        purpose: "audit handoff"
      }, "audit-pay-1", "198.51.100.67");

      const { requestId, metadataSig, submitSig } = parseFulfillUrl(activated.fulfill_url);
      const metadataResponse = await app.inject({
        method: "GET",
        url: `/api/v2/secret/metadata/${requestId}?sig=${encodeURIComponent(metadataSig)}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(metadataResponse.statusCode).toBe(200);

      const submitResponse = await app.inject({
        method: "POST",
        url: `/api/v2/secret/submit/${requestId}?sig=${encodeURIComponent(submitSig)}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          enc: "QUJDRA==",
          ciphertext: "RUZHSA=="
        }
      });
      expect(submitResponse.statusCode).toBe(201);

      const retrieveResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/retrieve`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(retrieveResponse.statusCode).toBe(200);

      const auditResponse = await app.inject({
        method: "GET",
        url: `/api/v2/audit?resource_id=${encodeURIComponent(activated.intent.intent_id)}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(auditResponse.statusCode).toBe(200);
      const auditPayload = auditResponse.json() as {
        records: Array<{
          event_type: string;
          actor_type: string | null;
          metadata: Record<string, unknown> | null;
        }>;
      };

      expect(auditPayload.records.some((record) => record.actor_type === "guest_agent")).toBe(true);
      const serialized = JSON.stringify(auditPayload.records);
      expect(serialized).not.toContain("RUZHSA==");
      expect(serialized).not.toContain("QUJDRA==");
      expect(serialized).not.toContain("guest-test-signature");
      expect(serialized).not.toContain("guest_access_token");
      expect(serialized).not.toContain("fulfill_url");

      for (const record of auditPayload.records) {
        const metadata = record.metadata ?? {};
        expect(metadata).not.toHaveProperty("ciphertext");
        expect(metadata).not.toHaveProperty("enc");
        expect(metadata).not.toHaveProperty("payment_signature");
        expect(metadata).not.toHaveProperty("guest_access_token");
        expect(metadata).not.toHaveProperty("fulfill_url");
      }

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("settles a paid guest human intent, enforces hosted workspace auth, and allows one retrieval", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-paid-human");
      await verifyOwner(app, pool, "guest-paid-human@example.com");
      const otherWorkspace = await registerOwner(app, pool, "guest-paid-other");
      await verifyOwner(app, pool, "guest-paid-other@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5,
        ttl_seconds: 300
      });

      const createPayload = {
        offer_token: created.offer_token,
        public_key: "QUJDRA==",
        purpose: "paid handoff"
      };
      const challengeResponse = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: {
          "x-forwarded-for": "198.51.100.44"
        },
        payload: createPayload
      });

      expect(challengeResponse.statusCode).toBe(402);
      const paymentRequiredHeader = challengeResponse.headers["payment-required"];
      expect(paymentRequiredHeader).toEqual(expect.any(String));
      const paymentRequired = decodePaymentRequired(paymentRequiredHeader as string);

      const paymentId = "guest-payment-1";
      const activationResponse = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: {
          "x-forwarded-for": "198.51.100.44",
          "payment-identifier": paymentId,
          "payment-signature": encodePaymentSignature({
            paymentId,
            paymentRequired
          })
        },
        payload: createPayload
      });

      expect(activationResponse.statusCode).toBe(201);
      expect(x402Provider.verifyCalls).toHaveLength(1);
      expect(x402Provider.settleCalls).toHaveLength(1);

      const activated = activationResponse.json() as {
        intent: { intent_id: string; status: string; request_id: string | null };
        request_id: string;
        fulfill_url: string;
        guest_access_token: string;
      };
      expect(activated.intent).toMatchObject({
        status: "activated",
        request_id: activated.request_id
      });

      const paymentRows = await pool.query<{ status: string; tx_hash: string | null }>(
        `
          SELECT status, tx_hash
          FROM guest_payments
          WHERE intent_id = $1
        `,
        [activated.intent.intent_id]
      );
      expect(paymentRows.rows).toHaveLength(1);
      expect(paymentRows.rows[0]).toMatchObject({
        status: "settled",
        tx_hash: "0xguestpayment"
      });

      const { requestId, metadataSig, submitSig } = parseFulfillUrl(activated.fulfill_url);
      expect(requestId).toBe(activated.request_id);

      const loggedOutMetadata = await app.inject({
        method: "GET",
        url: `/api/v2/secret/metadata/${requestId}?sig=${encodeURIComponent(metadataSig)}`
      });
      expect(loggedOutMetadata.statusCode).toBe(401);

      const wrongWorkspaceMetadata = await app.inject({
        method: "GET",
        url: `/api/v2/secret/metadata/${requestId}?sig=${encodeURIComponent(metadataSig)}`,
        headers: {
          authorization: `Bearer ${otherWorkspace.access_token}`
        }
      });
      expect(wrongWorkspaceMetadata.statusCode).toBe(403);
      expect(wrongWorkspaceMetadata.json()).toMatchObject({
        code: "workspace_mismatch"
      });

      const metadataResponse = await app.inject({
        method: "GET",
        url: `/api/v2/secret/metadata/${requestId}?sig=${encodeURIComponent(metadataSig)}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(metadataResponse.statusCode).toBe(200);
      expect(metadataResponse.json()).toMatchObject({
        description: expect.stringContaining("Purpose: paid handoff"),
        confirmation_code: expect.any(String)
      });

      const wrongWorkspaceSubmit = await app.inject({
        method: "POST",
        url: `/api/v2/secret/submit/${requestId}?sig=${encodeURIComponent(submitSig)}`,
        headers: {
          authorization: `Bearer ${otherWorkspace.access_token}`
        },
        payload: {
          enc: "QUJDRA==",
          ciphertext: "RUZHSA=="
        }
      });
      expect(wrongWorkspaceSubmit.statusCode).toBe(403);

      const submitResponse = await app.inject({
        method: "POST",
        url: `/api/v2/secret/submit/${requestId}?sig=${encodeURIComponent(submitSig)}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          enc: "QUJDRA==",
          ciphertext: "RUZHSA=="
        }
      });
      expect(submitResponse.statusCode).toBe(201);

      const deliveryStatus = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/delivery-status`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(deliveryStatus.statusCode).toBe(200);
      expect(deliveryStatus.json()).toMatchObject({
        intent_id: activated.intent.intent_id,
        request_id: requestId,
        status: "submitted"
      });

      const retrieveResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/retrieve`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(retrieveResponse.statusCode).toBe(200);
      expect(retrieveResponse.json()).toMatchObject({
        enc: "QUJDRA==",
        ciphertext: "RUZHSA=="
      });

      const secondRetrieve = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/retrieve`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(secondRetrieve.statusCode).toBe(410);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("creates a paid guest agent-delivery intent and returns exchange artifacts", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-agent-exchange");
      await verifyOwner(app, pool, "guest-agent-exchange@example.com");
      await enrollAgent(app, owner.access_token, "agent-alpha", "Agent Alpha");
      const created = await createOffer(app, owner.access_token, {
        delivery_mode: "agent",
        allowed_fulfiller_id: "agent-alpha",
        payment_policy: "always_x402",
        price_usd_cents: 5,
        secret_name: "restricted.secret"
      });

      const activated = await activatePaidAgentIntent(app, {
        offer_token: created.offer_token,
        public_key: "QUJDRA==",
        purpose: "agent delivery"
      }, "agent-exchange-pay-1", "198.51.100.71");

      expect(activated.intent).toMatchObject({
        status: "activated",
        exchange_id: activated.exchange_id
      });
      expect(activated.fulfillment_token).toEqual(expect.any(String));
      expect(activated.guest_access_token).toEqual(expect.any(String));

      const guestStatus = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/delivery-status`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(guestStatus.statusCode).toBe(200);
      expect(guestStatus.json()).toMatchObject({
        intent_id: activated.intent.intent_id,
        exchange_id: activated.exchange_id,
        status: "pending"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("denies a different workspace agent from fulfilling a guest-created exchange", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-agent-deny");
      await verifyOwner(app, pool, "guest-agent-deny@example.com");
      const allowedAgent = await enrollAgent(app, owner.access_token, "agent-allowed", "Allowed Agent");
      const wrongAgent = await enrollAgent(app, owner.access_token, "agent-wrong", "Wrong Agent");
      const wrongAgentAuth = await mintAgentToken(app, wrongAgent.bootstrap_api_key, "203.0.113.20");

      const created = await createOffer(app, owner.access_token, {
        delivery_mode: "agent",
        allowed_fulfiller_id: "agent-allowed",
        payment_policy: "always_x402",
        price_usd_cents: 5,
        secret_name: "restricted.secret"
      });

      const activated = await activatePaidAgentIntent(app, {
        offer_token: created.offer_token,
        public_key: "QkJCQg==",
        purpose: "wrong fulfiller"
      }, "agent-wrong-pay-1", "198.51.100.72");

      const wrongReserve = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/fulfill",
        headers: {
          authorization: `Bearer ${wrongAgentAuth.access_token}`
        },
        payload: {
          fulfillment_token: activated.fulfillment_token
        }
      });
      expect(wrongReserve.statusCode).toBe(409);
      expect(wrongReserve.json()).toMatchObject({
        error: "Exchange is reserved for a different fulfiller"
      });

      const guestStatus = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/delivery-status`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(guestStatus.statusCode).toBe(200);
      expect(guestStatus.json()).toMatchObject({
        status: "pending"
      });

      expect(allowedAgent.agent.agent_id).toBe("agent-allowed");

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("lets a guest poll and retrieve through the guest-created exchange lifecycle exactly once", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-agent-lifecycle");
      await verifyOwner(app, pool, "guest-agent-lifecycle@example.com");
      const agent = await enrollAgent(app, owner.access_token, "agent-runner", "Agent Runner");
      const agentAuth = await mintAgentToken(app, agent.bootstrap_api_key, "203.0.113.21");
      const created = await createOffer(app, owner.access_token, {
        delivery_mode: "agent",
        allowed_fulfiller_id: "agent-runner",
        payment_policy: "always_x402",
        price_usd_cents: 5,
        secret_name: "restricted.secret"
      });

      const activated = await activatePaidAgentIntent(app, {
        offer_token: created.offer_token,
        public_key: "Q0NDQw==",
        purpose: "agent lifecycle"
      }, "agent-lifecycle-pay-1", "198.51.100.73");

      const pendingStatus = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/delivery-status`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(pendingStatus.statusCode).toBe(200);
      expect(pendingStatus.json()).toMatchObject({ status: "pending" });

      const reserveResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/fulfill",
        headers: {
          authorization: `Bearer ${agentAuth.access_token}`
        },
        payload: {
          fulfillment_token: activated.fulfillment_token
        }
      });
      expect(reserveResponse.statusCode).toBe(200);
      expect(reserveResponse.json()).toMatchObject({
        exchange_id: activated.exchange_id,
        status: "reserved",
        fulfilled_by: "agent-runner"
      });

      const reservedStatus = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/delivery-status`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(reservedStatus.statusCode).toBe(200);
      expect(reservedStatus.json()).toMatchObject({
        status: "reserved",
        fulfilled_by: "agent-runner"
      });

      const submitResponse = await app.inject({
        method: "POST",
        url: `/api/v2/secret/exchange/submit/${activated.exchange_id}`,
        headers: {
          authorization: `Bearer ${agentAuth.access_token}`
        },
        payload: {
          enc: "QUJDRA==",
          ciphertext: "RUZHSA=="
        }
      });
      expect(submitResponse.statusCode).toBe(201);
      expect(submitResponse.json()).toMatchObject({
        status: "submitted",
        fulfilled_by: "agent-runner"
      });

      const submittedStatus = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/delivery-status`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(submittedStatus.statusCode).toBe(200);
      expect(submittedStatus.json()).toMatchObject({
        status: "submitted",
        fulfilled_by: "agent-runner"
      });

      const retrieveResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/retrieve`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(retrieveResponse.statusCode).toBe(200);
      expect(retrieveResponse.json()).toMatchObject({
        enc: "QUJDRA==",
        ciphertext: "RUZHSA=="
      });

      const retrievedStatus = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/delivery-status`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(retrievedStatus.statusCode).toBe(200);
      expect(retrievedStatus.json()).toMatchObject({
        status: "retrieved",
        fulfilled_by: "agent-runner"
      });

      const secondRetrieve = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/retrieve`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(secondRetrieve.statusCode).toBe(410);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("keeps approval-gated guest exchanges non-payable until approved and then completes them", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-agent-approval");
      await verifyOwner(app, pool, "guest-agent-approval@example.com");
      const agent = await enrollAgent(app, owner.access_token, "agent-gated", "Agent Gated");
      const agentAuth = await mintAgentToken(app, agent.bootstrap_api_key, "203.0.113.22");
      const created = await createOffer(app, owner.access_token, {
        delivery_mode: "agent",
        allowed_fulfiller_id: "agent-gated",
        payment_policy: "always_x402",
        price_usd_cents: 5,
        secret_name: "restricted.secret",
        require_approval: true
      });

      const payload = {
        offer_token: created.offer_token,
        public_key: "RERERA==",
        purpose: "approved exchange"
      };

      const pendingResponse = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: {
          "x-forwarded-for": "198.51.100.74"
        },
        payload
      });
      expect(pendingResponse.statusCode).toBe(202);
      const pending = pendingResponse.json() as {
        intent: { intent_id: string; status: string; approval_status: string | null };
      };
      expect(pending.intent).toMatchObject({
        status: "pending_approval",
        approval_status: "pending"
      });

      const approveResponse = await app.inject({
        method: "POST",
        url: `/api/v2/public/intents/${pending.intent.intent_id}/approve`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(approveResponse.statusCode).toBe(200);

      const { paymentRequired } = await createPaymentChallenge(app, payload, "198.51.100.74");
      const activationResponse = await submitPaidIntent(app, payload, paymentRequired, "agent-approval-pay-1", "198.51.100.74");
      expect(activationResponse.statusCode).toBe(201);
      const activated = activationResponse.json() as {
        intent: { intent_id: string; exchange_id: string | null };
        exchange_id: string;
        fulfillment_token: string;
        guest_access_token: string;
      };
      expect(activated.intent.exchange_id).toBe(activated.exchange_id);

      const reserveResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/fulfill",
        headers: {
          authorization: `Bearer ${agentAuth.access_token}`
        },
        payload: {
          fulfillment_token: activated.fulfillment_token
        }
      });
      expect(reserveResponse.statusCode).toBe(200);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("rejects delivery polling and retrieval when the guest token belongs to another intent", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-token-scope");
      await verifyOwner(app, pool, "guest-token-scope@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5
      });

      async function activateIntent(publicKey: string, paymentId: string) {
        const payload = {
          offer_token: created.offer_token,
          public_key: publicKey,
          purpose: `token scope ${paymentId}`
        };
        const challenge = await app.inject({
          method: "POST",
          url: "/api/v2/public/intents",
          headers: {
            "x-forwarded-for": paymentId === "scope-pay-1" ? "198.51.100.51" : "198.51.100.52"
          },
          payload
        });
        expect(challenge.statusCode).toBe(402);
        const paymentRequired = decodePaymentRequired(challenge.headers["payment-required"] as string);

        const activation = await app.inject({
          method: "POST",
          url: "/api/v2/public/intents",
          headers: {
            "x-forwarded-for": paymentId === "scope-pay-1" ? "198.51.100.51" : "198.51.100.52",
            "payment-identifier": paymentId,
            "payment-signature": encodePaymentSignature({ paymentId, paymentRequired })
          },
          payload
        });
        expect(activation.statusCode).toBe(201);
        return activation.json() as {
          intent: { intent_id: string };
          guest_access_token: string;
        };
      }

      const firstIntent = await activateIntent("QUJDRA==", "scope-pay-1");
      const secondIntent = await activateIntent("RkZGRg==", "scope-pay-2");

      const deliveryStatus = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${firstIntent.intent.intent_id}/delivery-status`,
        headers: {
          authorization: `Bearer ${secondIntent.guest_access_token}`
        }
      });
      expect(deliveryStatus.statusCode).toBe(410);

      const retrieveResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${firstIntent.intent.intent_id}/retrieve`,
        headers: {
          authorization: `Bearer ${secondIntent.guest_access_token}`
        }
      });
      expect(retrieveResponse.statusCode).toBe(410);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("keeps a guest agent-delivery exchange recoverable across a transport outage", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-agent-outage");
      await verifyOwner(app, pool, "guest-agent-outage@example.com");
      const agent = await enrollAgent(app, owner.access_token, "agent-recover", "Agent Recover");
      const agentAuth = await mintAgentToken(app, agent.bootstrap_api_key, "203.0.113.23");
      const created = await createOffer(app, owner.access_token, {
        delivery_mode: "agent",
        allowed_fulfiller_id: "agent-recover",
        payment_policy: "always_x402",
        price_usd_cents: 5,
        secret_name: "restricted.secret"
      });

      const activated = await activatePaidAgentIntent(app, {
        offer_token: created.offer_token,
        public_key: "RUVFRQ==",
        purpose: "runtime outage recovery"
      }, "agent-outage-pay-1", "198.51.100.75");

      const markFailedResponse = await app.inject({
        method: "POST",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/agent-delivery-failed`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          reason: "runtime transport unavailable"
        }
      });
      expect(markFailedResponse.statusCode).toBe(200);

      const failedStatus = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/delivery-status`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(failedStatus.statusCode).toBe(200);
      expect(failedStatus.json()).toMatchObject({
        intent_id: activated.intent.intent_id,
        exchange_id: activated.exchange_id,
        status: "delivery_failed",
        recoverable: true,
        fulfilled_by: null
      });

      const supportDetail = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/admin/${activated.intent.intent_id}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(supportDetail.statusCode).toBe(200);
      expect(supportDetail.json()).toMatchObject({
        intent: {
          id: activated.intent.intent_id,
          exchange_state: {
            status: "pending",
            fulfilled_by: null
          },
          agent_delivery: {
            state: "delivery_failed",
            recoverable: true,
            failure_reason: "runtime transport unavailable",
            attempt_count: 1
          }
        }
      });

      const retryResponse = await app.inject({
        method: "POST",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/retry-agent-delivery`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(retryResponse.statusCode).toBe(200);
      const retryPayload = retryResponse.json() as {
        fulfillment_token: string;
      };
      expect(retryPayload.fulfillment_token).toEqual(expect.any(String));

      const pendingStatus = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/delivery-status`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(pendingStatus.statusCode).toBe(200);
      expect(pendingStatus.json()).toMatchObject({
        status: "pending",
        recoverable: false
      });

      const reserveResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/fulfill",
        headers: {
          authorization: `Bearer ${agentAuth.access_token}`
        },
        payload: {
          fulfillment_token: retryPayload.fulfillment_token
        }
      });
      expect(reserveResponse.statusCode).toBe(200);
      expect(reserveResponse.json()).toMatchObject({
        exchange_id: activated.exchange_id,
        status: "reserved",
        fulfilled_by: "agent-recover"
      });

      const submitResponse = await app.inject({
        method: "POST",
        url: `/api/v2/secret/exchange/submit/${activated.exchange_id}`,
        headers: {
          authorization: `Bearer ${agentAuth.access_token}`
        },
        payload: {
          enc: "QUJDRA==",
          ciphertext: "RUZHSA=="
        }
      });
      expect(submitResponse.statusCode).toBe(201);

      const retrieveResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/retrieve`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(retrieveResponse.statusCode).toBe(200);
      expect(retrieveResponse.json()).toMatchObject({
        enc: "QUJDRA==",
        ciphertext: "RUZHSA=="
      });

      const revokedIntent = await activatePaidAgentIntent(app, {
        offer_token: created.offer_token,
        public_key: "RkZGRg==",
        purpose: "runtime outage revoke"
      }, "agent-outage-pay-2", "198.51.100.76");

      const markRevokedFailed = await app.inject({
        method: "POST",
        url: `/api/v2/public/intents/${revokedIntent.intent.intent_id}/agent-delivery-failed`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          reason: "runtime dispatcher down"
        }
      });
      expect(markRevokedFailed.statusCode).toBe(200);

      const revokeResponse = await app.inject({
        method: "POST",
        url: `/api/v2/public/intents/${revokedIntent.intent.intent_id}/revoke`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(revokeResponse.statusCode).toBe(200);

      const revokedStatus = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${revokedIntent.intent.intent_id}/delivery-status`,
        headers: {
          authorization: `Bearer ${revokedIntent.guest_access_token}`
        }
      });
      expect(revokedStatus.statusCode).toBe(410);

      const revokedRetrieve = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${revokedIntent.intent.intent_id}/retrieve`,
        headers: {
          authorization: `Bearer ${revokedIntent.guest_access_token}`
        }
      });
      expect(revokedRetrieve.statusCode).toBe(410);

      const revokedFulfill = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/fulfill",
        headers: {
          authorization: `Bearer ${agentAuth.access_token}`
        },
        payload: {
          fulfillment_token: revokedIntent.fulfillment_token
        }
      });
      expect(revokedFulfill.statusCode).toBe(409);
      expect(revokedFulfill.json()).toMatchObject({
        error: "Exchange is no longer pending"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("rate-limits public intent creation by IP and records the abuse signal", async () => {
    await withTemporaryEnv({
      SPS_PUBLIC_INTENT_IP_LIMIT: "2",
      SPS_PUBLIC_INTENT_OFFER_LIMIT: "50"
    }, async () => {
      const { pool, schema } = await createIsolatedPool();

      try {
        await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
        const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
        const owner = await registerOwner(app, pool, "guest-ip-rate-limit");
        await verifyOwner(app, pool, "guest-ip-rate-limit@example.com");
        const created = await createOffer(app, owner.access_token, {
          payment_policy: "always_x402",
          price_usd_cents: 5
        });

        const payload = {
          offer_token: created.offer_token,
          public_key: "UlJSUg==",
          purpose: "ip rate limit"
        };

        const first = await app.inject({
          method: "POST",
          url: "/api/v2/public/intents",
          headers: { "x-forwarded-for": "198.51.100.80" },
          payload
        });
        expect(first.statusCode).toBe(402);

        const second = await app.inject({
          method: "POST",
          url: "/api/v2/public/intents",
          headers: { "x-forwarded-for": "198.51.100.80" },
          payload
        });
        expect(second.statusCode).toBe(402);

        const third = await app.inject({
          method: "POST",
          url: "/api/v2/public/intents",
          headers: { "x-forwarded-for": "198.51.100.80" },
          payload
        });
        expect(third.statusCode).toBe(429);
        expect(third.json()).toMatchObject({
          code: "guest_intent_rate_limited"
        });

        const healthyIp = await app.inject({
          method: "POST",
          url: "/api/v2/public/intents",
          headers: { "x-forwarded-for": "198.51.100.81" },
          payload: {
            ...payload,
            public_key: "U1NTUw=="
          }
        });
        expect(healthyIp.statusCode).toBe(402);

        const auditRows = await pool.query<{ event_type: string; metadata: Record<string, unknown> }>(
          `
            SELECT event_type, metadata
            FROM audit_log
            WHERE event_type = 'guest_intent_rate_limited'
            ORDER BY created_at DESC
            LIMIT 1
          `
        );
        expect(auditRows.rows[0]).toMatchObject({
          event_type: "guest_intent_rate_limited",
          metadata: expect.objectContaining({
            scope: "ip",
            offer_id: created.offer.id,
            ip: "198.51.100.80"
          })
        });

        await app.close();
      } finally {
        await disposeIsolatedPool(pool, schema);
      }
    });
  });

  it("throttles an abused public offer without blocking other offers in the same workspace", async () => {
    await withTemporaryEnv({
      SPS_PUBLIC_INTENT_IP_LIMIT: "50",
      SPS_PUBLIC_INTENT_OFFER_LIMIT: "2"
    }, async () => {
      const { pool, schema } = await createIsolatedPool();

      try {
        await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
        const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
        const owner = await registerOwner(app, pool, "guest-offer-rate-limit");
        await verifyOwner(app, pool, "guest-offer-rate-limit@example.com");
        const abusedOffer = await createOffer(app, owner.access_token, {
          payment_policy: "always_x402",
          price_usd_cents: 5,
          offer_label: "Abused offer"
        });
        const healthyOffer = await createOffer(app, owner.access_token, {
          payment_policy: "always_x402",
          price_usd_cents: 5,
          offer_label: "Healthy offer"
        });

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await app.inject({
            method: "POST",
            url: "/api/v2/public/intents",
            headers: { "x-forwarded-for": "198.51.100.82" },
            payload: {
              offer_token: abusedOffer.offer_token,
              public_key: `VEVTVD${attempt}==`,
              purpose: `abuse ${attempt}`
            }
          });
          expect(response.statusCode).toBe(402);
        }

        const throttled = await app.inject({
          method: "POST",
          url: "/api/v2/public/intents",
          headers: { "x-forwarded-for": "198.51.100.82" },
          payload: {
            offer_token: abusedOffer.offer_token,
            public_key: "VEVTVDI=",
            purpose: "abuse 2"
          }
        });
        expect(throttled.statusCode).toBe(429);
        expect(throttled.json()).toMatchObject({
          code: "guest_offer_rate_limited"
        });

        const healthy = await app.inject({
          method: "POST",
          url: "/api/v2/public/intents",
          headers: { "x-forwarded-for": "198.51.100.82" },
          payload: {
            offer_token: healthyOffer.offer_token,
            public_key: "V09SS1M=",
            purpose: "healthy offer"
          }
        });
        expect(healthy.statusCode).toBe(402);

        await app.close();
      } finally {
        await disposeIsolatedPool(pool, schema);
      }
    });
  });

  it("cleans up expired unpaid guest intents so they no longer count as active and cannot be resumed", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
      const owner = await registerOwner(app, pool, "guest-cleanup");
      await verifyOwner(app, pool, "guest-cleanup@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5,
        ttl_seconds: 300
      });

      const payload = {
        offer_token: created.offer_token,
        public_key: "Q0xFQU4=",
        purpose: "cleanup me"
      };

      const initial = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: { "x-forwarded-for": "198.51.100.83" },
        payload
      });
      expect(initial.statusCode).toBe(402);
      const initialIntent = initial.json() as {
        intent: { intent_id: string };
      };

      await pool.query(
        `
          UPDATE guest_intents
          SET expires_at = now() - interval '1 second'
          WHERE id = $1
        `,
        [initialIntent.intent.intent_id]
      );

      const cleanupResponse = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents/admin/cleanup-expired",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(cleanupResponse.statusCode).toBe(200);
      expect(cleanupResponse.json()).toMatchObject({
        expired_intent_count: 1
      });

      const activeList = await app.inject({
        method: "GET",
        url: "/api/v2/public/intents/admin?status=payment_required",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(activeList.statusCode).toBe(200);
      expect((activeList.json() as { intents: Array<unknown> }).intents).toHaveLength(0);

      const resumed = await app.inject({
        method: "POST",
        url: "/api/v2/public/intents",
        headers: { "x-forwarded-for": "198.51.100.83" },
        payload
      });
      expect(resumed.statusCode).toBe(402);
      expect((resumed.json() as { intent: { intent_id: string } }).intent.intent_id).not.toBe(initialIntent.intent.intent_id);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("fails closed for expired paid-but-unfulfilled intents and shows expired support state", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const x402Provider = new TestX402Provider();
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true, x402Provider });
      const owner = await registerOwner(app, pool, "guest-expired-support");
      await verifyOwner(app, pool, "guest-expired-support@example.com");
      const created = await createOffer(app, owner.access_token, {
        payment_policy: "always_x402",
        price_usd_cents: 5,
        ttl_seconds: 300
      });

      const activated = await activatePaidHumanIntent(app, {
        offer_token: created.offer_token,
        public_key: "RVhQSVI=",
        purpose: "expire support view"
      }, "expire-support-pay-1", "198.51.100.84");

      await pool.query(
        `
          UPDATE guest_intents
          SET expires_at = now() - interval '1 second'
          WHERE id = $1
        `,
        [activated.intent.intent_id]
      );

      const retrieveResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/retrieve`,
        headers: {
          authorization: `Bearer ${activated.guest_access_token}`
        }
      });
      expect(retrieveResponse.statusCode).toBe(410);

      const statusResponse = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/${activated.intent.intent_id}/status?status_token=${encodeURIComponent(activated.intent.status_token)}`
      });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json()).toMatchObject({
        intent_id: activated.intent.intent_id,
        status: "expired"
      });

      const adminDetail = await app.inject({
        method: "GET",
        url: `/api/v2/public/intents/admin/${activated.intent.intent_id}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(adminDetail.statusCode).toBe(200);
      expect(adminDetail.json()).toMatchObject({
        intent: {
          id: activated.intent.intent_id,
          effective_status: "expired",
          request_state: {
            status: "pending"
          }
        }
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
