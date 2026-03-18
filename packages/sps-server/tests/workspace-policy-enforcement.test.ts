import { SignJWT } from "jose";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/index.js";
import { replaceWorkspacePolicy } from "../src/services/workspace-policy.js";
import { createWorkspace, updateWorkspaceTier } from "../src/services/workspace.js";

const runPgIntegration = process.env.SPS_PG_INTEGRATION === "1";
const describePg = runPgIntegration ? describe : describe.skip;
const migrationsDir = new URL("../src/db/migrations/", import.meta.url);

type App = Awaited<ReturnType<typeof buildApp>>;

let adminPool: Pool | null = null;
let originalAgentJwtSecret: string | undefined;
let originalHostedMode: string | undefined;
let originalRegistry: string | undefined;
let originalExchangePolicy: string | undefined;

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

  const schema = randomSchema("workspace_policy_enforcement");
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

describePg("workspace policy exchange enforcement", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set for PostgreSQL integration tests");
    }

    originalAgentJwtSecret = process.env.SPS_AGENT_JWT_SECRET;
    originalHostedMode = process.env.SPS_HOSTED_MODE;
    originalRegistry = process.env.SPS_SECRET_REGISTRY_JSON;
    originalExchangePolicy = process.env.SPS_EXCHANGE_POLICY_JSON;

    process.env.SPS_AGENT_JWT_SECRET = "test-agent-jwt-secret";
    process.env.SPS_HOSTED_MODE = "1";
    process.env.SPS_SECRET_REGISTRY_JSON = "[]";
    process.env.SPS_EXCHANGE_POLICY_JSON = "[]";

    adminPool = createDbPool({
      connectionString: process.env.DATABASE_URL,
      max: 1
    });
  });

  afterAll(async () => {
    process.env.SPS_AGENT_JWT_SECRET = originalAgentJwtSecret;
    process.env.SPS_HOSTED_MODE = originalHostedMode;
    process.env.SPS_SECRET_REGISTRY_JSON = originalRegistry;
    process.env.SPS_EXCHANGE_POLICY_JSON = originalExchangePolicy;
    await adminPool?.end();
    adminPool = null;
  });

  it("enforces workspace-specific DB policy on exchange request", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, hmacSecret: "test-hmac" });
      const workspaceA = await createWorkspace(pool, "policy-a", "Policy A");
      const workspaceB = await createWorkspace(pool, "policy-b", "Policy B");
      await updateWorkspaceTier(pool, workspaceA.id, "standard");
      await updateWorkspaceTier(pool, workspaceB.id, "standard");

      await replaceWorkspacePolicy(pool, workspaceA.id, {
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }],
        exchangePolicyRules: [{
          ruleId: "allow-a",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:crm-bot"],
          fulfillerIds: ["agent:payment-bot"],
          mode: "allow"
        }]
      }, {
        expectedVersion: 0,
        source: "test"
      });

      await replaceWorkspacePolicy(pool, workspaceB.id, {
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }],
        exchangePolicyRules: [{
          ruleId: "deny-b",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:crm-bot"],
          fulfillerIds: ["agent:payment-bot"],
          mode: "deny"
        }]
      }, {
        expectedVersion: 0,
        source: "test"
      });

      const tokenA = await issueHostedAgentToken(workspaceA.id, "agent:crm-bot");
      const tokenB = await issueHostedAgentToken(workspaceB.id, "agent:crm-bot");

      const allowResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${tokenA}`
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "stripe.api_key.prod",
          purpose: "charge-order",
          fulfiller_hint: "agent:payment-bot"
        }
      });

      expect(allowResponse.statusCode).toBe(201);

      const denyResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${tokenB}`
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "stripe.api_key.prod",
          purpose: "charge-order",
          fulfiller_hint: "agent:payment-bot"
        }
      });

      expect(denyResponse.statusCode).toBe(403);
      expect(denyResponse.json()).toMatchObject({
        error: "Exchange not allowed"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("rejects fulfillment after the workspace policy changes", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, hmacSecret: "test-hmac" });
      const workspace = await createWorkspace(pool, "policy-change", "Policy Change");
      await updateWorkspaceTier(pool, workspace.id, "standard");

      await replaceWorkspacePolicy(pool, workspace.id, {
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }],
        exchangePolicyRules: [{
          ruleId: "allow-before-change",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:crm-bot"],
          fulfillerIds: ["agent:payment-bot"],
          mode: "allow"
        }]
      }, {
        expectedVersion: 0,
        source: "test"
      });

      const requesterToken = await issueHostedAgentToken(workspace.id, "agent:crm-bot");
      const fulfillerToken = await issueHostedAgentToken(workspace.id, "agent:payment-bot");

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterToken}`
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "stripe.api_key.prod",
          purpose: "charge-order",
          fulfiller_hint: "agent:payment-bot"
        }
      });

      expect(createResponse.statusCode).toBe(201);
      const created = createResponse.json() as { fulfillment_token: string };

      await replaceWorkspacePolicy(pool, workspace.id, {
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }],
        exchangePolicyRules: [{
          ruleId: "deny-after-change",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:crm-bot"],
          fulfillerIds: ["agent:payment-bot"],
          mode: "deny"
        }]
      }, {
        expectedVersion: 1,
        source: "test"
      });

      const fulfillResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/fulfill",
        headers: {
          authorization: `Bearer ${fulfillerToken}`
        },
        payload: {
          fulfillment_token: created.fulfillment_token
        }
      });

      expect(fulfillResponse.statusCode).toBe(409);
      expect(fulfillResponse.json()).toMatchObject({
        error: "Exchange policy no longer allows fulfillment"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("applies a newly added pending-approval rule to the next matching exchange request", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, hmacSecret: "test-hmac" });
      const workspace = await createWorkspace(pool, "policy-approval", "Policy Approval");
      await updateWorkspaceTier(pool, workspace.id, "standard");

      await replaceWorkspacePolicy(pool, workspace.id, {
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }],
        exchangePolicyRules: [{
          ruleId: "allow-before-approval",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:crm-bot"],
          fulfillerIds: ["agent:payment-bot"],
          mode: "allow"
        }]
      }, {
        expectedVersion: 0,
        source: "test"
      });

      const requesterToken = await issueHostedAgentToken(workspace.id, "agent:crm-bot");

      const initialResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterToken}`
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "stripe.api_key.prod",
          purpose: "charge-order",
          fulfiller_hint: "agent:payment-bot"
        }
      });

      expect(initialResponse.statusCode).toBe(201);

      await replaceWorkspacePolicy(pool, workspace.id, {
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }],
        exchangePolicyRules: [{
          ruleId: "approval-after-update",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:crm-bot"],
          fulfillerIds: ["agent:payment-bot"],
          approverIds: ["user:ops-admin"],
          mode: "pending_approval",
          reason: "Finance secret requires human approval"
        }]
      }, {
        expectedVersion: 1,
        source: "test"
      });

      const approvalResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterToken}`
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "stripe.api_key.prod",
          purpose: "charge-order",
          fulfiller_hint: "agent:payment-bot"
        }
      });

      expect(approvalResponse.statusCode).toBe(403);
      expect(approvalResponse.json()).toMatchObject({
        error: "Exchange requires human approval",
        approval_status: "pending",
        policy: {
          mode: "pending_approval",
          rule_id: "approval-after-update"
        }
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("fails closed when a hosted workspace policy row is missing", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, hmacSecret: "test-hmac" });
      const workspace = await createWorkspace(pool, "policy-missing", "Policy Missing");
      await updateWorkspaceTier(pool, workspace.id, "standard");

      await replaceWorkspacePolicy(pool, workspace.id, {
        secretRegistry: [{
          secretName: "stripe.api_key.prod",
          classification: "finance"
        }],
        exchangePolicyRules: [{
          ruleId: "allow-before-delete",
          secretName: "stripe.api_key.prod",
          requesterIds: ["agent:crm-bot"],
          fulfillerIds: ["agent:payment-bot"],
          mode: "allow"
        }]
      }, {
        expectedVersion: 0,
        source: "test"
      });

      await pool.query("DELETE FROM workspace_policy_documents WHERE workspace_id = $1", [workspace.id]);

      const requesterToken = await issueHostedAgentToken(workspace.id, "agent:crm-bot");
      const response = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterToken}`
        },
        payload: {
          public_key: "cHVibGlj",
          secret_name: "stripe.api_key.prod",
          purpose: "charge-order",
          fulfiller_hint: "agent:payment-bot"
        }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: "Hosted workspace policy is unavailable for this workspace",
        code: "workspace_policy_missing"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
