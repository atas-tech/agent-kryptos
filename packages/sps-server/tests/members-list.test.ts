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

  const schema = randomSchema("members_list");
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

describePg("members list pagination & lockout", () => {
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

  it("paginates workspace-scoped member lists and enforces last-admin lockout", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
      const owner = await registerOwner(app, "paged-members");
      await verifyOwner(app, pool, "paged-members@example.com");

      // Upgrade to standard tier to bypass member limits
      await pool.query("UPDATE workspaces SET tier = 'standard' WHERE id = $1", [owner.user.workspace_id]);

      // Seed 3 more members for owner (total 4 including owner)
      for (let i = 0; i < 3; i++) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v2/members",
          headers: {
            authorization: `Bearer ${owner.access_token}`
          },
          payload: {
            email: `member-${i}@example.com`,
            temporary_password: "MemberTemp123!",
            role: "workspace_viewer"
          }
        });
        expect(response.statusCode).toBe(201);
      }

      // Assert Page 1 (limit 2)
      const page1 = await app.inject({
        method: "GET",
        url: "/api/v2/members?limit=2",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(page1.statusCode).toBe(200);
      const payload1 = page1.json();
      expect(payload1.members).toHaveLength(2);
      expect(payload1.next_cursor).toBeDefined();

      // Assert Page 2 (limit 2)
      const page2 = await app.inject({
        method: "GET",
        url: `/api/v2/members?limit=2&cursor=${encodeURIComponent(payload1.next_cursor)}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(page2.statusCode).toBe(200);
      const payload2 = page2.json();
      expect(payload2.members).toHaveLength(2);
      expect(payload2.next_cursor).toBeNull(); // Should be last page (total 4 members)

      // Test Last-Admin Lockout
      const lockoutResponse = await app.inject({
        method: "PATCH",
        url: `/api/v2/members/${owner.user.id}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          role: "workspace_viewer"
        }
      });
      expect(lockoutResponse.statusCode).toBe(409);
      expect(lockoutResponse.json().code).toBe("last_admin_lockout");

      const suspendResponse = await app.inject({
        method: "PATCH",
        url: `/api/v2/members/${owner.user.id}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          status: "suspended"
        }
      });
      expect(suspendResponse.statusCode).toBe(409);
      expect(suspendResponse.json().code).toBe("last_admin_lockout");

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
