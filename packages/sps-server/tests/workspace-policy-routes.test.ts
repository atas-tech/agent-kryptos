import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/index.js";

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

  const schema = randomSchema("workspace_policy_routes");
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

async function registerOwner(app: Awaited<ReturnType<typeof buildApp>>, identity: string) {
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
    user: { id: string; workspace_id: string };
  };
}

async function verifyOwner(app: Awaited<ReturnType<typeof buildApp>>, pool: Pool, email: string): Promise<void> {
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

describePg("workspace policy routes", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set for PostgreSQL integration tests");
    }

    process.env.SPS_USER_JWT_SECRET = "test-user-jwt-secret";
    process.env.SPS_AGENT_JWT_SECRET = "test-agent-jwt-secret";
    process.env.SPS_HOSTED_MODE = "1";
    process.env.SPS_MEMBER_LIMIT_FREE = "10";
    adminPool = createDbPool({
      connectionString: process.env.DATABASE_URL,
      max: 1
    });
  });

  afterAll(async () => {
    await adminPool?.end();
    adminPool = null;
  });

  it("validates and updates workspace policy for admins", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
      const owner = await registerOwner(app, "policy-admin");
      await verifyOwner(app, pool, "policy-admin@example.com");

      const validateBad = await app.inject({
        method: "POST",
        url: "/api/v2/workspace/policy/validate",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          secret_registry: [{
            secretName: "stripe.api_key.prod",
            classification: "finance"
          }],
          exchange_policy: [{
            ruleId: "allow-stripe",
            secretName: "missing.secret",
            mode: "allow"
          }]
        }
      });

      expect(validateBad.statusCode).toBe(200);
      expect(validateBad.json()).toMatchObject({
        valid: false,
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "unknown_secret_name"
          })
        ])
      });

      const patchResponse = await app.inject({
        method: "PATCH",
        url: "/api/v2/workspace/policy",
        headers: {
          authorization: `Bearer ${owner.access_token}`,
          "x-forwarded-for": "203.0.113.25"
        },
        payload: {
          expected_version: 1,
          secret_registry: [{
            secretName: "stripe.api_key.prod",
            classification: "finance",
            description: "Stripe production key"
          }],
          exchange_policy: [{
            ruleId: "allow-stripe",
            secretName: "stripe.api_key.prod",
            requesterIds: ["agent:crm-bot"],
            fulfillerIds: ["agent:payment-bot"],
            mode: "allow"
          }]
        }
      });

      expect(patchResponse.statusCode).toBe(200);
      expect(patchResponse.json()).toMatchObject({
        policy: {
          workspace_id: owner.user.workspace_id,
          version: 2,
          source: "manual",
          updated_by_user_id: owner.user.id,
          secret_registry: [{
            secretName: "stripe.api_key.prod",
            classification: "finance",
            description: "Stripe production key"
          }],
          exchange_policy: [{
            ruleId: "allow-stripe",
            secretName: "stripe.api_key.prod",
            requesterIds: ["agent:crm-bot"],
            fulfillerIds: ["agent:payment-bot"],
            mode: "allow"
          }]
        }
      });

      const getResponse = await app.inject({
        method: "GET",
        url: "/api/v2/workspace/policy",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });

      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json()).toMatchObject({
        policy: {
          version: 2,
          source: "manual"
        }
      });

      const auditResponse = await app.inject({
        method: "GET",
        url: "/api/v2/audit?event_type=workspace_policy_updated",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });

      expect(auditResponse.statusCode).toBe(200);
      expect(auditResponse.json()).toMatchObject({
        records: expect.arrayContaining([
          expect.objectContaining({
            event_type: "workspace_policy_updated",
            actor_id: owner.user.id,
            actor_type: "user"
          })
        ])
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("allows operators to read but not update workspace policy", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
      const owner = await registerOwner(app, "policy-operator");
      await verifyOwner(app, pool, "policy-operator@example.com");
      await pool.query("UPDATE workspaces SET tier = 'standard' WHERE id = $1", [owner.user.workspace_id]);

      const createOperatorResponse = await app.inject({
        method: "POST",
        url: "/api/v2/members",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          email: "workspace-operator@example.com",
          temporary_password: "OperatorTemp123!",
          role: "workspace_operator"
        }
      });
      expect(createOperatorResponse.statusCode).toBe(201);

      const operatorLogin = await login(app, "workspace-operator@example.com", "OperatorTemp123!");
      const operatorAccessToken = await changePassword(
        app,
        operatorLogin.access_token,
        "OperatorTemp123!",
        "OperatorNew123!"
      );

      const patchResponse = await app.inject({
        method: "PATCH",
        url: "/api/v2/workspace/policy",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          expected_version: 1,
          secret_registry: [{
            secretName: "stripe.api_key.prod",
            classification: "finance"
          }],
          exchange_policy: [{
            ruleId: "allow-stripe",
            secretName: "stripe.api_key.prod",
            mode: "allow"
          }]
        }
      });
      expect(patchResponse.statusCode).toBe(200);

      const getResponse = await app.inject({
        method: "GET",
        url: "/api/v2/workspace/policy",
        headers: {
          authorization: `Bearer ${operatorAccessToken}`
        }
      });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json()).toMatchObject({
        policy: {
          version: 2
        }
      });

      const operatorPatchAttempt = await app.inject({
        method: "PATCH",
        url: "/api/v2/workspace/policy",
        headers: {
          authorization: `Bearer ${operatorAccessToken}`
        },
        payload: {
          expected_version: 2,
          secret_registry: [{
            secretName: "stripe.api_key.prod",
            classification: "finance"
          }],
          exchange_policy: []
        }
      });
      expect(operatorPatchAttempt.statusCode).toBe(403);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
