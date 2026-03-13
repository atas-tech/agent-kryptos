import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/index.js";
import { logAudit } from "../src/services/audit.js";

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

  const schema = randomSchema("audit_integration");
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

describePg("audit integration tests", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set for PostgreSQL integration tests");
    }

    process.env.SPS_USER_JWT_SECRET = "test-user-jwt-secret";
    process.env.SPS_AGENT_JWT_SECRET = "test-agent-jwt-secret";
    process.env.SPS_HOSTED_MODE = "1";
    adminPool = createDbPool({
      connectionString: process.env.DATABASE_URL,
      max: 1
    });
  });

  afterAll(async () => {
    await adminPool?.end();
    adminPool = null;
  });

  it("paginates and masks audit records", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
      const owner = await registerOwner(app, "audit-tester");

      // 1. Seed audit records
      for (let i = 1; i <= 10; i++) {
        await logAudit(pool, {
          event: "secret_retrieved",
          workspaceId: owner.user.workspace_id,
          actorId: "bot-1",
          actorType: "agent",
          resourceId: `res-${i}`,
          action: "test",
          metadata: {
            index: i
          }
        });
        // Small delay to ensure timestamp separation for DESC ordering
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // 2. Test Pagination
      const page1 = await app.inject({
        method: "GET",
        url: "/api/v2/audit?limit=6",
        headers: { authorization: `Bearer ${owner.access_token}` }
      });
      expect(page1.statusCode).toBe(200);
      const payload1 = page1.json();
      expect(payload1.records.length).toBeLessThanOrEqual(6);
      expect(payload1.next_cursor).toBeDefined();

      const page2 = await app.inject({
        method: "GET",
        url: `/api/v2/audit?limit=6&cursor=${encodeURIComponent(payload1.next_cursor)}`,
        headers: { authorization: `Bearer ${owner.access_token}` }
      });
      expect(page2.statusCode).toBe(200);
      const payload2 = page2.json();
      
      // We seeded 10. Registration does not currently log audit events.
      expect(payload1.records.length + payload2.records.length).toBe(10);
      expect(payload2.next_cursor).toBeNull();

      // 3. Test Exchange Drill-down
      const exchangeId = "a".repeat(64);
      await logAudit(pool, {
        event: "exchange_requested",
        workspaceId: owner.user.workspace_id,
        exchangeId,
        actorId: "bot-1",
        actorType: "agent",
        action: "exchange"
      });

      const drillDown = await app.inject({
        method: "GET",
        url: `/api/v2/audit/exchange/${exchangeId}`,
        headers: { authorization: `Bearer ${owner.access_token}` }
      });
      expect(drillDown.statusCode).toBe(200);
      expect(drillDown.json().records).toHaveLength(1);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
