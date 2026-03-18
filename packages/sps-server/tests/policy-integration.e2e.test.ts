import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  const schema = randomSchema("policy_i");
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

async function createApp(pool: Pool): Promise<App> {
  return buildApp({
    db: pool,
    useInMemoryStore: true,
    trustProxy: true,
    hmacSecret: "test-hmac",
    baseUrl: "http://localhost:3100"
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

async function enrollAgent(app: App, accessToken: string, agentId: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/agents",
    headers: {
      authorization: `Bearer ${accessToken}`
    },
    payload: { agent_id: agentId }
  });

  return response;
}

async function mintAgentToken(app: App, apiKey: string) {
  return app.inject({
    method: "POST",
    url: "/api/v2/agents/token",
    headers: {
      authorization: `Bearer ${apiKey}`
    }
  });
}

describePg("Hosted Workspace Policy Integration E2E", { timeout: 30_000 }, () => {
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

  it("enforces cross-component policy: dashboard update -> agent exchange with approval", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createApp(pool);
      const owner = await registerOwner(app, "policy-integration");
      await verifyOwner(app, pool, "policy-integration@example.com");

      // Upgrade to standard to allow agents-to-agent exchange (if tier-restricted)
      await pool.query("UPDATE workspaces SET tier = 'standard' WHERE id = $1", [owner.user.workspace_id]);

      // Enroll agents
      const requesterEnrollRes = await enrollAgent(app, owner.access_token, "requester-agent");
      const requesterKey = requesterEnrollRes.json().bootstrap_api_key;
      const requesterToken = (await mintAgentToken(app, requesterKey)).json().access_token;

      const fulfillerEnrollRes = await enrollAgent(app, owner.access_token, "fulfiller-agent");
      const fulfillerKey = fulfillerEnrollRes.json().bootstrap_api_key;
      const fulfillerToken = (await mintAgentToken(app, fulfillerKey)).json().access_token;

      // Check initial policy
      const initialPolicyRes = await app.inject({
        method: "GET",
        url: "/api/v2/workspace/policy",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });

      // 1. Initially, exchange might be allowed by bootstrap (standard policy often allows internal)
      // but let's set a strict policy.
      const updateRes = await app.inject({
        method: "PATCH",
        url: "/api/v2/workspace/policy",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          secret_registry: [{
            secretName: "app.db.password",
            classification: "infrastructure"
          }],
          exchange_policy: [{
            ruleId: "require-approval-for-db",
            secretName: "app.db.password",
            requesterIds: ["requester-agent"],
            fulfillerIds: ["fulfiller-agent"],
            mode: "pending_approval",
            reason: "Database access must be manually approved"
          }],
          expected_version: initialPolicyRes.json().policy?.version ?? 1
        }
      });
      expect(updateRes.statusCode).toBe(200);

      // 2. Requester tries to request exchange
      const requestRes = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterToken}`
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "app.db.password",
          purpose: "database-migration",
          fulfiller_hint: "fulfiller-agent"
        }
      });

      expect(requestRes.statusCode).toBe(403);
      const body = requestRes.json();
      expect(body.error).toBe("Exchange requires human approval");
      expect(body.approval_status).toBe("pending");
      const approvalReference = body.policy.approval_reference;
      expect(approvalReference).toBeTruthy();

      // 3. Admin approves
      const approveRes = await app.inject({
        method: "POST",
        url: `/api/v2/secret/exchange/admin/approval/${approvalReference}/approve`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(approveRes.statusCode).toBe(200);

      // 4. Requester tries again -> Success
      const requestRes2 = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterToken}`
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "app.db.password",
          purpose: "database-migration",
          fulfiller_hint: "fulfiller-agent"
        }
      });
      expect(requestRes2.statusCode).toBe(201);
      const { exchange_id, fulfillment_token } = requestRes2.json();

      // 5. Fulfiller fulfills (step 1: reserve)
      const fulfillRes = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/fulfill",
        headers: {
          authorization: `Bearer ${fulfillerToken}`
        },
        payload: {
          fulfillment_token
        }
      });
      expect(fulfillRes.statusCode).toBe(200);
      const { exchange_id: reservedExchangeId } = fulfillRes.json();

      // 5b. Fulfiller fulfills (step 2: submit data)
      const submitRes = await app.inject({
        method: "POST",
        url: `/api/v2/secret/exchange/submit/${reservedExchangeId}`,
        headers: {
          authorization: `Bearer ${fulfillerToken}`
        },
        payload: {
          enc: "ZW5j",
          ciphertext: "Y2lwaGVydGV4dA=="
        }
      });
      expect(submitRes.statusCode).toBe(201);

      // 6. Requester retrieves
      const retrieveRes = await app.inject({
        method: "GET",
        url: `/api/v2/secret/exchange/retrieve/${reservedExchangeId}`,
        headers: {
          authorization: `Bearer ${requesterToken}`
        }
      });
      expect(retrieveRes.statusCode).toBe(200);
      expect(retrieveRes.json()).toMatchObject({ enc: "ZW5j", ciphertext: "Y2lwaGVydGV4dA==" });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
