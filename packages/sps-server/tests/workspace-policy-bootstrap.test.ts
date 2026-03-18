import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/index.js";
import { getWorkspacePolicy } from "../src/services/workspace-policy.js";
import { createWorkspace } from "../src/services/workspace.js";

const runPgIntegration = process.env.SPS_PG_INTEGRATION === "1";
const describePg = runPgIntegration ? describe : describe.skip;
const migrationsDir = new URL("../src/db/migrations/", import.meta.url);

let adminPool: Pool | null = null;
let originalHostedMode: string | undefined;
let originalRegistry: string | undefined;
let originalExchangePolicy: string | undefined;
let originalUserJwtSecret: string | undefined;

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

  const schema = randomSchema("workspace_policy_bootstrap");
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

describePg("workspace policy bootstrap and seeding", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set for PostgreSQL integration tests");
    }

    originalHostedMode = process.env.SPS_HOSTED_MODE;
    originalRegistry = process.env.SPS_SECRET_REGISTRY_JSON;
    originalExchangePolicy = process.env.SPS_EXCHANGE_POLICY_JSON;
    originalUserJwtSecret = process.env.SPS_USER_JWT_SECRET;

    process.env.SPS_HOSTED_MODE = "1";
    process.env.SPS_USER_JWT_SECRET = "test-user-jwt-secret";
    adminPool = createDbPool({
      connectionString: process.env.DATABASE_URL,
      max: 1
    });
  });

  afterAll(async () => {
    process.env.SPS_HOSTED_MODE = originalHostedMode;
    process.env.SPS_SECRET_REGISTRY_JSON = originalRegistry;
    process.env.SPS_EXCHANGE_POLICY_JSON = originalExchangePolicy;
    process.env.SPS_USER_JWT_SECRET = originalUserJwtSecret;
    await adminPool?.end();
    adminPool = null;
  });

  it("auto-seeds existing hosted workspaces from bootstrap policy on startup", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const workspace = await createWorkspace(pool, "seed-existing", "Seed Existing");

      process.env.SPS_SECRET_REGISTRY_JSON = JSON.stringify([{
        secretName: "stripe.api_key.prod",
        classification: "finance"
      }]);
      process.env.SPS_EXCHANGE_POLICY_JSON = JSON.stringify([{
        ruleId: "allow-startup",
        secretName: "stripe.api_key.prod",
        requesterIds: ["agent:crm-bot"],
        fulfillerIds: ["agent:payment-bot"],
        mode: "allow"
      }]);

      const app = await buildApp({ db: pool, useInMemoryStore: true });
      await app.close();

      const seeded = await getWorkspacePolicy(pool, workspace.id);
      expect(seeded).toMatchObject({
        workspaceId: workspace.id,
        version: 1,
        source: "env_seed",
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }]
      });

      process.env.SPS_SECRET_REGISTRY_JSON = JSON.stringify([{
        secretName: "other.secret",
        classification: "other"
      }]);
      process.env.SPS_EXCHANGE_POLICY_JSON = JSON.stringify([]);

      const app2 = await buildApp({ db: pool, useInMemoryStore: true });
      await app2.close();

      const reseeded = await getWorkspacePolicy(pool, workspace.id);
      expect(reseeded).toMatchObject({
        version: 1,
        source: "env_seed",
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }]
      });
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("initializes new hosted workspaces from the bootstrap policy on registration", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      process.env.SPS_SECRET_REGISTRY_JSON = JSON.stringify([{
        secretName: "stripe.api_key.prod",
        classification: "finance"
      }]);
      process.env.SPS_EXCHANGE_POLICY_JSON = JSON.stringify([{
        ruleId: "allow-register",
        secretName: "stripe.api_key.prod",
        requesterIds: ["agent:crm-bot"],
        fulfillerIds: ["agent:payment-bot"],
        mode: "allow"
      }]);

      const app = await buildApp({ db: pool, useInMemoryStore: true });
      const response = await app.inject({
        method: "POST",
        url: "/api/v2/auth/register",
        payload: {
          email: "bootstrap@example.com",
          password: "Password123!",
          workspace_slug: "bootstrap-space",
          display_name: "Bootstrap Space"
        }
      });

      expect(response.statusCode).toBe(201);
      const payload = response.json() as { user: { workspace_id: string } };

      const policy = await getWorkspacePolicy(pool, payload.user.workspace_id);
      expect(policy).toMatchObject({
        workspaceId: payload.user.workspace_id,
        version: 1,
        source: "bootstrap",
        exchangePolicyRules: [{
          ruleId: "allow-register",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:crm-bot"],
          fulfillerIds: ["agent:payment-bot"],
          mode: "allow"
        }]
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("fails closed when the hosted bootstrap policy is invalid", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const workspace = await createWorkspace(pool, "seed-invalid", "Seed Invalid");

      process.env.SPS_SECRET_REGISTRY_JSON = JSON.stringify([]);
      process.env.SPS_EXCHANGE_POLICY_JSON = JSON.stringify([{
        ruleId: "allow-invalid",
        secretName: "missing.secret",
        requesterIds: ["agent:crm-bot"],
        fulfillerIds: ["agent:payment-bot"],
        mode: "allow"
      }]);

      await expect(buildApp({ db: pool, useInMemoryStore: true })).rejects.toThrow("Workspace policy document is invalid");

      const persistedPolicy = await getWorkspacePolicy(pool, workspace.id);
      expect(persistedPolicy).toBeNull();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
