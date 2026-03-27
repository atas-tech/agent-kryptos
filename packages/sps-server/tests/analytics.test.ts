import { URL } from "node:url";
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

  const schema = randomSchema("analytics");
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

async function createAnalyticsApp(pool: Pool): Promise<App> {
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
    headers: {
      "x-forwarded-for": "203.0.113.40"
    },
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

async function login(app: App, email: string, password: string, ip = "198.51.100.30") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: {
      "x-forwarded-for": ip
    },
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

async function setUserRole(pool: Pool, email: string, role: "workspace_admin" | "workspace_operator" | "workspace_viewer"): Promise<void> {
  await pool.query(
    "UPDATE users SET role = $2, updated_at = now() WHERE email = $1",
    [email, role]
  );
}

function utcDayString(daysAgo: number): string {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, 12, 0, 0));
  return date.toISOString().slice(0, 10);
}

function utcTimestamp(daysAgo: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo, 12, 0, 0)).toISOString();
}

async function insertAuditLog(
  pool: Pool,
  row: {
    workspaceId: string;
    eventType: string;
    actorId?: string | null;
    actorType?: "user" | "agent" | "system" | null;
    resourceId?: string | null;
    createdAt: string;
  }
): Promise<void> {
  await pool.query(
    `
      INSERT INTO audit_log (workspace_id, event_type, actor_id, actor_type, resource_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
    `,
    [
      row.workspaceId,
      row.eventType,
      row.actorId ?? null,
      row.actorType ?? null,
      row.resourceId ?? null,
      row.createdAt
    ]
  );
}

describePg("Milestone 2 analytics routes", () => {
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

  it("returns workspace-scoped request volume and exchange outcome series", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createAnalyticsApp(pool);
      const ownerA = await registerOwner(app, "analytics-owner-a");
      await verifyOwner(app, pool, "analytics-owner-a@example.com");
      const ownerB = await registerOwner(app, "analytics-owner-b");
      await verifyOwner(app, pool, "analytics-owner-b@example.com");

      await insertAuditLog(pool, {
        workspaceId: ownerA.user.workspace_id,
        eventType: "request_created",
        createdAt: utcTimestamp(0)
      });
      await insertAuditLog(pool, {
        workspaceId: ownerA.user.workspace_id,
        eventType: "request_created",
        createdAt: utcTimestamp(0)
      });
      await insertAuditLog(pool, {
        workspaceId: ownerA.user.workspace_id,
        eventType: "request_created",
        createdAt: utcTimestamp(1)
      });
      await insertAuditLog(pool, {
        workspaceId: ownerB.user.workspace_id,
        eventType: "request_created",
        createdAt: utcTimestamp(0)
      });

      await insertAuditLog(pool, {
        workspaceId: ownerA.user.workspace_id,
        eventType: "exchange_revoked",
        createdAt: utcTimestamp(2)
      });
      await insertAuditLog(pool, {
        workspaceId: ownerA.user.workspace_id,
        eventType: "exchange_denied",
        createdAt: utcTimestamp(1)
      });
      await insertAuditLog(pool, {
        workspaceId: ownerA.user.workspace_id,
        eventType: "exchange_retrieved",
        createdAt: utcTimestamp(0)
      });
      await insertAuditLog(pool, {
        workspaceId: ownerA.user.workspace_id,
        eventType: "exchange_rejected",
        createdAt: utcTimestamp(0)
      });
      await insertAuditLog(pool, {
        workspaceId: ownerB.user.workspace_id,
        eventType: "exchange_retrieved",
        createdAt: utcTimestamp(0)
      });

      const requestsResponse = await app.inject({
        method: "GET",
        url: "/api/v2/analytics/requests?days=3",
        headers: {
          authorization: `Bearer ${ownerA.access_token}`
        }
      });
      expect(requestsResponse.statusCode).toBe(200);
      expect(requestsResponse.json()).toEqual({
        days: 3,
        series: [
          { date: utcDayString(2), count: 0 },
          { date: utcDayString(1), count: 1 },
          { date: utcDayString(0), count: 2 }
        ]
      });

      const exchangesResponse = await app.inject({
        method: "GET",
        url: "/api/v2/analytics/exchanges?days=3",
        headers: {
          authorization: `Bearer ${ownerA.access_token}`
        }
      });
      expect(exchangesResponse.statusCode).toBe(200);
      expect(exchangesResponse.json()).toEqual({
        days: 3,
        series: [
          { date: utcDayString(2), successful: 0, failed_expired: 1, denied: 0 },
          { date: utcDayString(1), successful: 0, failed_expired: 0, denied: 1 },
          { date: utcDayString(0), successful: 1, failed_expired: 0, denied: 1 }
        ]
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("counts distinct recently active agents for operators and blocks viewers", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createAnalyticsApp(pool);
      const owner = await registerOwner(app, "analytics-agents");
      await verifyOwner(app, pool, "analytics-agents@example.com");

      const agentAResponse = await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          agent_id: "analytics-agent-a",
          display_name: "Analytics Agent A"
        }
      });
      expect(agentAResponse.statusCode).toBe(201);
      const agentAKey = (agentAResponse.json() as { bootstrap_api_key: string }).bootstrap_api_key;

      const agentBResponse = await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          agent_id: "analytics-agent-b",
          display_name: "Analytics Agent B"
        }
      });
      expect(agentBResponse.statusCode).toBe(201);
      const agentBKey = (agentBResponse.json() as { bootstrap_api_key: string }).bootstrap_api_key;

      for (const apiKey of [agentAKey, agentAKey, agentBKey]) {
        const mintResponse = await app.inject({
          method: "POST",
          url: "/api/v2/agents/token",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "x-forwarded-for": "198.51.100.31"
          }
        });
        expect(mintResponse.statusCode).toBe(200);
      }

      await insertAuditLog(pool, {
        workspaceId: owner.user.workspace_id,
        eventType: "agent_token_minted",
        actorId: "stale-agent",
        actorType: "agent",
        resourceId: "stale-agent",
        createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString()
      });

      await setUserRole(pool, "analytics-agents@example.com", "workspace_operator");
      const operator = await login(app, "analytics-agents@example.com", "Password123!", "198.51.100.32");

      const agentsResponse = await app.inject({
        method: "GET",
        url: "/api/v2/analytics/agents?hours=24",
        headers: {
          authorization: `Bearer ${operator.access_token}`
        }
      });
      expect(agentsResponse.statusCode).toBe(200);
      expect(agentsResponse.json()).toEqual({
        hours: 24,
        active_agents: 2
      });

      await setUserRole(pool, "analytics-agents@example.com", "workspace_viewer");
      const viewer = await login(app, "analytics-agents@example.com", "Password123!", "198.51.100.33");

      const forbiddenResponse = await app.inject({
        method: "GET",
        url: "/api/v2/analytics/agents?hours=24",
        headers: {
          authorization: `Bearer ${viewer.access_token}`
        }
      });
      expect(forbiddenResponse.statusCode).toBe(403);
      expect(forbiddenResponse.json()).toEqual({
        error: "Insufficient role"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
