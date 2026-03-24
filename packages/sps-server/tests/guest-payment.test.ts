import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { verifyAndSettleGuestPayment } from "../src/services/guest-payment.js";
import {
  buildPaymentRequiredPayload,
  type X402Config,
  type X402Provider,
  type X402Quote,
  type X402SettleInput,
  type X402VerifyInput
} from "../src/services/x402.js";

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

  const schema = randomSchema("guest_payment");
  await adminPool.query(`CREATE SCHEMA "${schema}"`);

  return {
    schema,
    pool: createDbPool({
      connectionString: withSearchPath(process.env.DATABASE_URL, schema),
      max: 4
    })
  };
}

async function disposeIsolatedPool(pool: Pool, schema: string): Promise<void> {
  await pool.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

class CountingProvider implements X402Provider {
  readonly name = "counting-x402";
  readonly verifyCalls: X402VerifyInput[] = [];
  readonly settleCalls: X402SettleInput[] = [];

  async verifyPayment(input: X402VerifyInput) {
    this.verifyCalls.push(input);
    return {
      valid: true,
      payer: "guest-agent"
    };
  }

  async settlePayment(input: X402SettleInput) {
    this.settleCalls.push(input);
    return {
      status: "settled" as const,
      txHash: "0xguestpayment"
    };
  }
}

function paymentQuote(): X402Quote {
  return {
    amountUsdCents: 5,
    amountAssetUnits: "50000",
    amountAssetDisplay: "0.05",
    networkId: "eip155:84532",
    resource: "/api/v2/public/intents",
    description: "Guest intent payment",
    payTo: "0x0000000000000000000000000000000000000001",
    quoteExpiresAt: Math.floor(Date.now() / 1000) + 300
  };
}

function x402Config(quote: X402Quote): X402Config {
  return {
    enabled: true,
    facilitatorUrl: "https://facilitator.example.test",
    payToAddress: quote.payTo,
    priceUsdCents: quote.amountUsdCents,
    freeExchangeMonthlyCap: 10,
    networkId: quote.networkId,
    quoteTtlSeconds: 300,
    leaseDurationSeconds: 60,
    providerTimeoutMs: 20_000
  };
}

function paymentSignature(paymentId: string, quote: X402Quote): string {
  const paymentRequired = buildPaymentRequiredPayload(quote);
  return JSON.stringify({
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: paymentRequired.accepts[0],
    payload: {
      paymentId,
      payer: "guest-agent",
      signature: "guest-test-signature"
    },
    extensions: {
      blindpass: {
        paymentId
      }
    }
  });
}

async function seedGuestIntent(pool: Pool) {
  const workspaceId = "00000000-0000-4000-8000-000000000111";
  const userId = "00000000-0000-4000-8000-000000000112";
  const offerId = "00000000-0000-4000-8000-000000000113";
  const intentId = "00000000-0000-4000-8000-000000000114";

  await pool.query(
    `
      INSERT INTO workspaces (id, slug, display_name)
      VALUES ($1, 'guest-payment-space', 'Guest Payment Space')
    `,
    [workspaceId]
  );

  await pool.query(
    `
      INSERT INTO users (id, email, password_hash, email_verified, workspace_id)
      VALUES ($1, 'guest-payment-owner@example.com', 'password-hash', true, $2)
    `,
    [userId, workspaceId]
  );

  await pool.query("UPDATE workspaces SET owner_user_id = $1 WHERE id = $2", [userId, workspaceId]);

  await pool.query(
    `
      INSERT INTO public_offers (
        id,
        workspace_id,
        created_by_user_id,
        delivery_mode,
        payment_policy,
        price_usd_cents,
        secret_name,
        token_hash,
        expires_at
      )
      VALUES (
        $1,
        $2,
        $3,
        'human',
        'always_x402',
        5,
        'stripe.api_key.prod',
        'token-hash',
        now() + interval '1 day'
      )
    `,
    [offerId, workspaceId, userId]
  );

  await pool.query(
    `
      INSERT INTO guest_intents (
        id,
        workspace_id,
        offer_id,
        actor_type,
        status,
        requester_public_key,
        requester_public_key_hash,
        guest_subject_hash,
        purpose,
        delivery_mode,
        payment_policy,
        price_usd_cents,
        resolved_secret_name,
        status_token,
        policy_snapshot_json,
        expires_at
      )
      VALUES (
        $1,
        $2,
        $3,
        'guest_agent',
        'payment_required',
        'QUJDRA==',
        'public-key-hash',
        'guest-subject-hash',
        'Guest payment race test',
        'human',
        'always_x402',
        5,
        'stripe.api_key.prod',
        'status-token',
        '{}'::jsonb,
        now() + interval '1 day'
      )
    `,
    [intentId, workspaceId, offerId]
  );

  return {
    workspaceId,
    intentId
  };
}

describePg("guest payment settlement", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      return;
    }

    adminPool = createDbPool({
      connectionString: process.env.DATABASE_URL,
      max: 2
    });
  });

  afterAll(async () => {
    await adminPool?.end();
    adminPool = null;
  });

  it("does not call the provider when a concurrent payment row wins the insert race", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const { workspaceId, intentId } = await seedGuestIntent(pool);
      const provider = new CountingProvider();
      const quote = paymentQuote();
      const config = x402Config(quote);
      const paymentId = "guest-race-payment";
      const requestHash = "guest-race-request-hash";

      const lockingClient = await pool.connect();
      try {
        await lockingClient.query("BEGIN");
        await lockingClient.query(
          `
            INSERT INTO guest_payments (
              workspace_id,
              intent_id,
              payment_id,
              request_hash,
              quoted_amount_cents,
              quoted_currency,
              quoted_asset_symbol,
              quoted_asset_amount,
              scheme,
              network_id,
              facilitator_url,
              quote_expires_at,
              status
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              5,
              'USD',
              'USDC',
              '0.05',
              'exact',
              'eip155:84532',
              'https://facilitator.example.test',
              now() + interval '5 minutes',
              'pending'
            )
          `,
          [workspaceId, intentId, paymentId, requestHash]
        );

        const verificationAttempt = verifyAndSettleGuestPayment(pool, provider, config, {
          workspaceId,
          intentId,
          requestHash,
          paymentId,
          paymentSignature: paymentSignature(paymentId, quote),
          quote
        });

        await new Promise((resolve) => setTimeout(resolve, 20));
        await lockingClient.query("COMMIT");

        await expect(verificationAttempt).rejects.toMatchObject({
          code: "payment_in_progress"
        });
        expect(provider.verifyCalls).toHaveLength(0);
        expect(provider.settleCalls).toHaveLength(0);
      } finally {
        lockingClient.release();
      }
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
