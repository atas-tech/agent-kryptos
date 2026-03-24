import { SignJWT } from "jose";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrollAgent } from "../src/services/agent.js";
import { MockBillingProvider } from "../src/services/billing.js";
import type { X402PaymentRequired, X402Provider, X402SettleInput, X402VerifyInput } from "../src/services/x402.js";
import { createDbPool } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/index.js";

const runPgIntegration = process.env.SPS_PG_INTEGRATION === "1";
const describePg = runPgIntegration ? describe : describe.skip;
const migrationsDir = new URL("../src/db/migrations/", import.meta.url);

type App = Awaited<ReturnType<typeof buildApp>>;

let adminPool: Pool | null = null;
let originalUserJwtSecret: string | undefined;
let originalAgentJwtSecret: string | undefined;
let originalHostedMode: string | undefined;
let originalX402Enabled: string | undefined;
let originalX402PayToAddress: string | undefined;
let originalX402FacilitatorUrl: string | undefined;
let originalX402PriceCents: string | undefined;
let originalX402FreeCap: string | undefined;
let originalX402NetworkId: string | undefined;

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

  const schema = randomSchema("x402");
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
  const result = await pool.query<{ verification_token: string }>(
    "SELECT verification_token FROM users WHERE email = $1 LIMIT 1",
    [email]
  );
  const token = result.rows[0]?.verification_token;
  expect(token).toEqual(expect.any(String));

  const response = await app.inject({
    method: "GET",
    url: `/api/v2/auth/verify-email/${token}`
  });

  expect(response.statusCode).toBe(200);
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

function utcMonthStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
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
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: params.paymentRequired.resource,
    accepted: option,
    payload: {
      paymentId: params.paymentId,
      payer: params.payer ?? "agent:crm-bot",
      signature: "test-signature"
    },
    extensions: {
      blindpass: {
        paymentId: params.paymentId
      }
    }
  }), "utf8").toString("base64");
}

class TestX402Provider implements X402Provider {
  readonly name = "test-x402";
  readonly verifyCalls: X402VerifyInput[] = [];
  readonly settleCalls: X402SettleInput[] = [];
  private settleGate: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  holdSettlement(): void {
    this.settleGate = new Promise((resolve) => {
      this.releaseGate = resolve;
    });
  }

  releaseSettlement(): void {
    this.releaseGate?.();
    this.settleGate = null;
    this.releaseGate = null;
  }

  async verifyPayment(input: X402VerifyInput) {
    this.verifyCalls.push(input);
    return {
      valid: true,
      payer: typeof input.paymentPayload.payload.payer === "string" ? input.paymentPayload.payload.payer : null
    } as const;
  }

  async settlePayment(input: X402SettleInput) {
    this.settleCalls.push(input);
    if (this.settleGate) {
      await this.settleGate;
    }

    return {
      status: "settled",
      txHash: `0x${input.paymentId.padEnd(64, "0").slice(0, 64)}`
    } as const;
  }
}

async function createX402App(pool: Pool, provider: X402Provider): Promise<App> {
  return buildApp({
    db: pool,
    billingProvider: new MockBillingProvider(),
    x402Provider: provider,
    useInMemoryStore: true,
    hmacSecret: "test-hmac",
    trustProxy: true,
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

async function exhaustFreeCap(pool: Pool, workspaceId: string, used = 10): Promise<void> {
  await pool.query(
    `
      INSERT INTO workspace_exchange_usage (workspace_id, usage_month, free_exchange_used, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (workspace_id, usage_month)
      DO UPDATE SET free_exchange_used = EXCLUDED.free_exchange_used, updated_at = now()
    `,
    [workspaceId, utcMonthStart(), used]
  );
}

describePg("x402 routes", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set for PostgreSQL integration tests");
    }

    originalUserJwtSecret = process.env.SPS_USER_JWT_SECRET;
    originalAgentJwtSecret = process.env.SPS_AGENT_JWT_SECRET;
    originalHostedMode = process.env.SPS_HOSTED_MODE;
    originalX402Enabled = process.env.SPS_X402_ENABLED;
    originalX402PayToAddress = process.env.SPS_X402_PAY_TO_ADDRESS;
    originalX402FacilitatorUrl = process.env.SPS_X402_FACILITATOR_URL;
    originalX402PriceCents = process.env.SPS_X402_PRICE_USD_CENTS;
    originalX402FreeCap = process.env.SPS_X402_FREE_EXCHANGE_MONTHLY_CAP;
    originalX402NetworkId = process.env.SPS_X402_NETWORK_ID;

    process.env.SPS_USER_JWT_SECRET = "test-user-jwt-secret";
    process.env.SPS_AGENT_JWT_SECRET = "test-agent-jwt-secret";
    process.env.SPS_HOSTED_MODE = "1";
    process.env.SPS_X402_ENABLED = "1";
    process.env.SPS_X402_PAY_TO_ADDRESS = "0x0000000000000000000000000000000000000001";
    process.env.SPS_X402_FACILITATOR_URL = "https://facilitator.test";
    process.env.SPS_X402_PRICE_USD_CENTS = "5";
    process.env.SPS_X402_FREE_EXCHANGE_MONTHLY_CAP = "10";
    process.env.SPS_X402_NETWORK_ID = "eip155:84532";

    adminPool = createDbPool({
      connectionString: process.env.DATABASE_URL,
      max: 1
    });
  });

  afterAll(async () => {
    process.env.SPS_USER_JWT_SECRET = originalUserJwtSecret;
    process.env.SPS_AGENT_JWT_SECRET = originalAgentJwtSecret;
    process.env.SPS_HOSTED_MODE = originalHostedMode;
    process.env.SPS_X402_ENABLED = originalX402Enabled;
    process.env.SPS_X402_PAY_TO_ADDRESS = originalX402PayToAddress;
    process.env.SPS_X402_FACILITATOR_URL = originalX402FacilitatorUrl;
    process.env.SPS_X402_PRICE_USD_CENTS = originalX402PriceCents;
    process.env.SPS_X402_FREE_EXCHANGE_MONTHLY_CAP = originalX402FreeCap;
    process.env.SPS_X402_NETWORK_ID = originalX402NetworkId;
    await adminPool?.end();
    adminPool = null;
  });

  it("returns 402 with PAYMENT-REQUIRED after the monthly free cap is exhausted", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const provider = new TestX402Provider();
      const app = await createX402App(pool, provider);
      const owner = await registerOwner(app, "x402-required");
      await verifyOwner(app, pool, "x402-required@example.com");
      await enrollAgent(pool, owner.user.workspace_id, "agent:crm-bot", "CRM Bot");
      await exhaustFreeCap(pool, owner.user.workspace_id);

      const requesterJwt = await issueHostedAgentToken(owner.user.workspace_id, "agent:crm-bot");
      const response = await app.inject({
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

      expect(response.statusCode).toBe(402);
      const paymentRequiredHeader = response.headers["payment-required"];
      expect(paymentRequiredHeader).toEqual(expect.any(String));

      const paymentRequired = decodePaymentRequired(String(paymentRequiredHeader));
      expect(paymentRequired).toMatchObject({
        x402Version: 2,
        accepts: [{
          scheme: "exact",
          network: "eip155:84532",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          amount: "50000"
        }],
        metadata: {
          quoted_amount_cents: 5,
          quoted_asset_symbol: "USDC",
          quoted_asset_amount: "0.05"
        }
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("denies paid retries by default when the agent has no allowance", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const provider = new TestX402Provider();
      const app = await createX402App(pool, provider);
      const owner = await registerOwner(app, "x402-no-allowance");
      await verifyOwner(app, pool, "x402-no-allowance@example.com");
      await enrollAgent(pool, owner.user.workspace_id, "agent:crm-bot", "CRM Bot");
      await exhaustFreeCap(pool, owner.user.workspace_id);

      const requesterJwt = await issueHostedAgentToken(owner.user.workspace_id, "agent:crm-bot");
      const preflight = await app.inject({
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

      const paymentRequired = decodePaymentRequired(String(preflight.headers["payment-required"]));
      const paymentId = "pid-no-allowance";
      const paidAttempt = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterJwt}`,
          "payment-identifier": paymentId,
          "payment-signature": encodePaymentSignature({
            paymentId,
            paymentRequired
          })
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "stripe.api_key.prod",
          purpose: "charge-order",
          fulfiller_hint: "agent:payment-bot"
        }
      });

      expect(paidAttempt.statusCode).toBe(403);
      expect(paidAttempt.json()).toMatchObject({
        code: "x402_budget_denied"
      });

      const audit = await pool.query<{ event_type: string }>(
        "SELECT event_type FROM audit_log WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1",
        [owner.user.workspace_id]
      );
      expect(audit.rows[0]?.event_type).toBe("x402_payment_failed");

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("settles a paid request, increments spend, and supports idempotent retry", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const provider = new TestX402Provider();
      const app = await createX402App(pool, provider);
      const owner = await registerOwner(app, "x402-success");
      await verifyOwner(app, pool, "x402-success@example.com");
      await enrollAgent(pool, owner.user.workspace_id, "agent:crm-bot", "CRM Bot");
      await exhaustFreeCap(pool, owner.user.workspace_id);

      const allowanceResponse = await app.inject({
        method: "POST",
        url: "/api/v2/billing/allowances",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          agent_id: "agent:crm-bot",
          monthly_budget_cents: 25
        }
      });
      expect(allowanceResponse.statusCode).toBe(201);

      const requesterJwt = await issueHostedAgentToken(owner.user.workspace_id, "agent:crm-bot");
      const preflight = await app.inject({
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

      const paymentRequired = decodePaymentRequired(String(preflight.headers["payment-required"]));
      const paymentId = "pid-success";
      const paidAttempt = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterJwt}`,
          "payment-identifier": paymentId,
          "payment-signature": encodePaymentSignature({
            paymentId,
            paymentRequired
          })
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "stripe.api_key.prod",
          purpose: "charge-order",
          fulfiller_hint: "agent:payment-bot"
        }
      });

      expect(paidAttempt.statusCode).toBe(201);
      const created = paidAttempt.json() as { exchange_id: string };
      expect(paidAttempt.headers["payment-response"]).toEqual(expect.any(String));

      const idempotentRetry = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterJwt}`,
          "payment-identifier": paymentId,
          "payment-signature": encodePaymentSignature({
            paymentId,
            paymentRequired
          })
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "stripe.api_key.prod",
          purpose: "charge-order",
          fulfiller_hint: "agent:payment-bot"
        }
      });

      expect(idempotentRetry.statusCode).toBe(201);
      expect(idempotentRetry.json()).toMatchObject(created);

      const allowances = await app.inject({
        method: "GET",
        url: "/api/v2/billing/allowances",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(allowances.statusCode).toBe(200);
      expect(allowances.json()).toMatchObject({
        allowances: [
          {
            agent_id: "agent:crm-bot",
            monthly_budget_cents: 25,
            current_spend_cents: 5,
            remaining_budget_cents: 20
          }
        ]
      });

      const ledger = await app.inject({
        method: "GET",
        url: "/api/v2/billing/x402/transactions",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(ledger.statusCode).toBe(200);
      expect(ledger.json()).toMatchObject({
        transactions: [
          {
            agent_id: "agent:crm-bot",
            payment_id: paymentId,
            quoted_amount_cents: 5,
            quoted_asset_symbol: "USDC",
            quoted_asset_amount: "0.05",
            network_id: "eip155:84532",
            status: "settled"
          }
        ]
      });

      const txRows = await pool.query<{ payment_id: string; status: string; tx_hash: string | null }>(
        `
          SELECT payment_id, status, tx_hash
          FROM x402_transactions
          WHERE workspace_id = $1
        `,
        [owner.user.workspace_id]
      );
      expect(txRows.rows).toHaveLength(1);
      expect(txRows.rows[0]).toMatchObject({
        payment_id: paymentId,
        status: "settled"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("returns 409 payment_in_progress for concurrent paid requests from the same agent", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const provider = new TestX402Provider();
      provider.holdSettlement();
      const app = await createX402App(pool, provider);
      const owner = await registerOwner(app, "x402-concurrency");
      await verifyOwner(app, pool, "x402-concurrency@example.com");
      await enrollAgent(pool, owner.user.workspace_id, "agent:crm-bot", "CRM Bot");
      await exhaustFreeCap(pool, owner.user.workspace_id);

      await app.inject({
        method: "POST",
        url: "/api/v2/billing/allowances",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          agent_id: "agent:crm-bot",
          monthly_budget_cents: 25
        }
      });

      const requesterJwt = await issueHostedAgentToken(owner.user.workspace_id, "agent:crm-bot");
      const preflight = await app.inject({
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
      const paymentRequired = decodePaymentRequired(String(preflight.headers["payment-required"]));

      const firstRequest = app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterJwt}`,
          "payment-identifier": "pid-concurrency-1",
          "payment-signature": encodePaymentSignature({
            paymentId: "pid-concurrency-1",
            paymentRequired
          })
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "stripe.api_key.prod",
          purpose: "charge-order",
          fulfiller_hint: "agent:payment-bot"
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      const secondRequest = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterJwt}`,
          "payment-identifier": "pid-concurrency-2",
          "payment-signature": encodePaymentSignature({
            paymentId: "pid-concurrency-2",
            paymentRequired
          })
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "stripe.api_key.prod",
          purpose: "charge-order-2",
          fulfiller_hint: "agent:payment-bot"
        }
      });

      expect(secondRequest.statusCode).toBe(409);
      expect(secondRequest.json()).toMatchObject({
        code: "payment_in_progress"
      });

      provider.releaseSettlement();
      const firstResponse = await firstRequest;
      expect(firstResponse.statusCode).toBe(201);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
