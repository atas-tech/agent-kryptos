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

  const schema = randomSchema("agents_list");
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
  await pool.query("UPDATE users SET email_verified = true WHERE email = $1", [email]);
}

describePg("agents list pagination", () => {
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

  it("paginates and filters workspace-scoped agent lists", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
      const owner = await registerOwner(app, "paged-agents");
      await verifyOwner(app, pool, "paged-agents@example.com");

      const otherOwner = await registerOwner(app, "other-agents");
      await verifyOwner(app, pool, "other-agents@example.com");

      // Seed 5 agents for owner
      for (let i = 0; i < 5; i++) {
        await app.inject({
          method: "POST",
          url: "/api/v2/agents",
          headers: {
            authorization: `Bearer ${owner.access_token}`
          },
          payload: {
            agent_id: `agent-${i}`,
            display_name: `Agent ${i}`
          }
        });
      }

      // Seed 1 agent for other workspace
      await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${otherOwner.access_token}`
        },
        payload: {
          agent_id: "other-agent"
        }
      });

      // Revoke agent-2
      await app.inject({
        method: "DELETE",
        url: "/api/v2/agents/agent-2",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });

      // Assert Page 1 (limit 2)
      const page1 = await app.inject({
        method: "GET",
        url: "/api/v2/agents?limit=2",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(page1.statusCode).toBe(200);
      const payload1 = page1.json();
      expect(payload1.agents).toHaveLength(2);
      expect(payload1.next_cursor).toBeDefined();

      // Assert Page 2 (limit 2)
      const page2 = await app.inject({
        method: "GET",
        url: `/api/v2/agents?limit=2&cursor=${encodeURIComponent(payload1.next_cursor)}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(page2.statusCode).toBe(200);
      const payload2 = page2.json();
      expect(payload2.agents).toHaveLength(2);
      expect(payload2.next_cursor).toBeDefined();

      // Assert Page 3 (limit 2)
      const page3 = await app.inject({
        method: "GET",
        url: `/api/v2/agents?limit=2&cursor=${encodeURIComponent(payload2.next_cursor)}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(page3.statusCode).toBe(200);
      const payload3 = page3.json();
      expect(payload3.agents).toHaveLength(1);
      expect(payload3.next_cursor).toBeNull();

      // Verify workspace scoping (should not see other-agent)
      const allAgents = [...payload1.agents, ...payload2.agents, ...payload3.agents];
      expect(allAgents.some(a => a.agent_id === "other-agent")).toBe(false);

      // Verify status filtering
      const activeAgents = await app.inject({
        method: "GET",
        url: "/api/v2/agents?status=active",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(activeAgents.json().agents).toHaveLength(4);

      const revokedAgents = await app.inject({
        method: "GET",
        url: "/api/v2/agents?status=revoked",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(revokedAgents.json().agents).toHaveLength(1);
      expect(revokedAgents.json().agents[0].agent_id).toBe("agent-2");

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
