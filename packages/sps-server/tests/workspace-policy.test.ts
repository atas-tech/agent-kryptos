import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import {
  WorkspacePolicyEngineCache,
  WorkspacePolicyResolver,
  WorkspacePolicyServiceError,
  ensureWorkspacePolicy,
  getWorkspacePolicy,
  replaceWorkspacePolicy,
  validateWorkspacePolicyDocument
} from "../src/services/workspace-policy.js";
import { createWorkspace } from "../src/services/workspace.js";

const runPgIntegration = process.env.SPS_PG_INTEGRATION === "1";
const describePg = runPgIntegration ? describe : describe.skip;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, "../src/db/migrations");

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
  if (!adminPool) {
    throw new Error("admin pool not initialized");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set for PostgreSQL integration tests");
  }

  const schema = randomSchema("workspace_policy");
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const pool = createDbPool({
    connectionString: withSearchPath(databaseUrl, schema),
    max: 1
  });

  return { pool, schema };
}

async function disposeIsolatedPool(pool: Pool, schema: string): Promise<void> {
  await pool.end();
  await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

describe("workspace policy validation", () => {
  it("rejects duplicate rule ids and unknown secret references", () => {
    const result = validateWorkspacePolicyDocument({
      secretRegistry: [{
        secretName: "stripe.api_key.prod",
        classification: "finance"
      }],
      exchangePolicyRules: [
        {
          ruleId: "duplicate",
          secretName: "stripe.api_key.prod",
          mode: "allow"
        },
        {
          ruleId: "duplicate",
          secretName: "missing.secret",
          mode: "deny"
        }
      ]
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "duplicate_rule_id",
        path: "exchangePolicyRules[1].ruleId"
      }),
      expect.objectContaining({
        code: "unknown_secret_name",
        path: "exchangePolicyRules[1].secretName"
      })
    ]));
  });

  it("rejects runtime-generated fields in persisted rules", () => {
    const result = validateWorkspacePolicyDocument({
      secretRegistry: [{
        secretName: "stripe.api_key.prod",
        classification: "finance"
      }],
      exchangePolicyRules: [{
        ruleId: "approval",
        secretName: "stripe.api_key.prod",
        mode: "pending_approval",
        approvalReference: "apr_123"
      }]
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "disallowed_field",
        path: "exchangePolicyRules[0].approvalReference"
      })
    ]));
  });

  it("reuses compiled engines for the same workspace version", () => {
    const cache = new WorkspacePolicyEngineCache();
    const record = {
      id: "policy-1",
      workspaceId: "workspace-1",
      version: 2,
      updatedByUserId: null,
      source: "manual" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
      secretRegistry: [{
        secretName: "stripe.api_key.prod",
        classification: "finance"
      }],
      exchangePolicyRules: [{
        ruleId: "allow-stripe",
        secretName: "stripe.api_key.prod",
        mode: "allow"
      }]
    };

    const first = cache.get(record);
    const second = cache.get(record);

    expect(second).toBe(first);
  });

  it("fails closed for hosted workspaces without a persisted policy", async () => {
    const originalHostedMode = process.env.SPS_HOSTED_MODE;
    process.env.SPS_HOSTED_MODE = "1";

    try {
      const resolver = new WorkspacePolicyResolver({
        db: {
          query: async () => ({ rows: [] })
        } as any
      });

      await expect(resolver.resolve("workspace-1")).rejects.toBeInstanceOf(WorkspacePolicyServiceError);
      await expect(resolver.resolve("workspace-1")).rejects.toMatchObject({
        code: "workspace_policy_missing"
      });
    } finally {
      process.env.SPS_HOSTED_MODE = originalHostedMode;
    }
  });
});

describePg("workspace policy storage", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set for PostgreSQL integration tests");
    }

    adminPool = createDbPool({
      connectionString: process.env.DATABASE_URL,
      max: 1
    });
  });

  afterAll(async () => {
    await adminPool?.end();
    adminPool = null;
  });

  it("seeds an initial version once and reads it back", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir });
      const workspace = await createWorkspace(pool, "policy-seed", "Policy Seed");

      const seeded = await ensureWorkspacePolicy(pool, workspace.id, {
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }],
        exchangePolicyRules: [{
          ruleId: "allow-stripe",
          secretName: "stripe.api_key.prod",
          mode: "allow"
        }]
      }, {
        source: "bootstrap"
      });

      const repeated = await ensureWorkspacePolicy(pool, workspace.id, {
        secretRegistry: [{
          secretName: "other.secret",
          classification: "ignored"
        }],
        exchangePolicyRules: []
      }, {
        source: "manual"
      });

      const fetched = await getWorkspacePolicy(pool, workspace.id);

      expect(seeded.version).toBe(1);
      expect(repeated.id).toBe(seeded.id);
      expect(fetched).toMatchObject({
        id: seeded.id,
        version: 1,
        source: "bootstrap"
      });
      expect(fetched?.secretRegistry).toEqual([{
        secretName: "stripe.api_key.prod",
        classification: "finance"
      }]);
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("replaces policy documents with optimistic concurrency", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir });
      const workspace = await createWorkspace(pool, "policy-replace", "Policy Replace");

      const first = await replaceWorkspacePolicy(pool, workspace.id, {
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }],
        exchangePolicyRules: [{
          ruleId: "allow-stripe",
          secretName: "stripe.api_key.prod",
          mode: "allow"
        }]
      }, {
        expectedVersion: 0,
        source: "manual"
      });

      const second = await replaceWorkspacePolicy(pool, workspace.id, {
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }],
        exchangePolicyRules: [{
          ruleId: "approve-stripe",
          secretName: "stripe.api_key.prod",
          mode: "pending_approval"
        }]
      }, {
        expectedVersion: 1,
        source: "manual"
      });

      expect(first.version).toBe(1);
      expect(second.version).toBe(2);

      await expect(replaceWorkspacePolicy(pool, workspace.id, {
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }],
        exchangePolicyRules: []
      }, {
        expectedVersion: 1,
        source: "manual"
      })).rejects.toMatchObject({
        code: "policy_version_conflict"
      } satisfies Partial<WorkspacePolicyServiceError>);
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
