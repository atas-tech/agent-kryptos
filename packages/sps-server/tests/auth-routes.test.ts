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

  const schema = randomSchema("auth");
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

describePg("auth routes", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set for PostgreSQL integration tests");
    }

    process.env.SPS_USER_JWT_SECRET = "test-user-jwt-secret";
    adminPool = createDbPool({
      connectionString: process.env.DATABASE_URL,
      max: 1
    });
  });

  afterAll(async () => {
    await adminPool?.end();
    adminPool = null;
  });

  it("registers, normalizes email, and exposes auth/me", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });

      const registerResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/register",
        headers: {
          "user-agent": "vitest-register"
        },
        payload: {
          email: "  OWNER@Example.COM ",
          password: "Password123!",
          workspace_slug: "acme-auth",
          display_name: "Acme Auth"
        }
      });

      expect(registerResponse.statusCode).toBe(201);
      const registered = registerResponse.json() as {
        access_token: string;
        refresh_token: string;
        user: { email: string; email_verified: boolean; force_password_change: boolean; role: string };
        workspace: { slug: string; display_name: string };
      };

      expect(registered.user).toMatchObject({
        email: "owner@example.com",
        email_verified: false,
        force_password_change: false,
        role: "workspace_admin"
      });
      expect(registered.workspace).toMatchObject({
        slug: "acme-auth",
        display_name: "Acme Auth"
      });
      expect(registered.access_token).toEqual(expect.any(String));
      expect(registered.refresh_token).toEqual(expect.any(String));

      const meResponse = await app.inject({
        method: "GET",
        url: "/api/v2/auth/me",
        headers: {
          authorization: `Bearer ${registered.access_token}`
        }
      });

      expect(meResponse.statusCode).toBe(200);
      expect(meResponse.json()).toMatchObject({
        user: {
          email: "owner@example.com"
        },
        workspace: {
          slug: "acme-auth"
        }
      });

      const duplicateResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/register",
        payload: {
          email: "owner@example.com",
          password: "Password123!",
          workspace_slug: "another-auth",
          display_name: "Another Auth"
        }
      });

      expect(duplicateResponse.statusCode).toBe(409);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("logs in with normalized email and rejects wrong passwords", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });

      await app.inject({
        method: "POST",
        url: "/api/v2/auth/register",
        payload: {
          email: "login@example.com",
          password: "Password123!",
          workspace_slug: "login-space",
          display_name: "Login Space"
        }
      });

      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/login",
        payload: {
          email: " LOGIN@example.com ",
          password: "Password123!"
        }
      });

      expect(loginResponse.statusCode).toBe(200);
      expect(loginResponse.json()).toMatchObject({
        user: {
          email: "login@example.com"
        }
      });

      const badPasswordResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/login",
        payload: {
          email: "login@example.com",
          password: "wrong-password"
        }
      });

      expect(badPasswordResponse.statusCode).toBe(401);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("rotates refresh tokens strictly and revokes refresh after logout", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });

      const registerResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/register",
        payload: {
          email: "refresh@example.com",
          password: "Password123!",
          workspace_slug: "refresh-space",
          display_name: "Refresh Space"
        }
      });

      const registered = registerResponse.json() as { access_token: string; refresh_token: string };

      const refreshResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/refresh",
        payload: {
          refresh_token: registered.refresh_token
        }
      });

      expect(refreshResponse.statusCode).toBe(200);
      const refreshed = refreshResponse.json() as { access_token: string; refresh_token: string };
      expect(refreshed.refresh_token).not.toBe(registered.refresh_token);

      const oldRefreshResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/refresh",
        payload: {
          refresh_token: registered.refresh_token
        }
      });

      expect(oldRefreshResponse.statusCode).toBe(401);

      const logoutResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/logout",
        headers: {
          authorization: `Bearer ${refreshed.access_token}`
        }
      });

      expect(logoutResponse.statusCode).toBe(204);

      const refreshAfterLogoutResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/refresh",
        payload: {
          refresh_token: refreshed.refresh_token
        }
      });

      expect(refreshAfterLogoutResponse.statusCode).toBe(401);

      const stillValidAccessResponse = await app.inject({
        method: "GET",
        url: "/api/v2/auth/me",
        headers: {
          authorization: `Bearer ${refreshed.access_token}`
        }
      });

      expect(stillValidAccessResponse.statusCode).toBe(200);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("requires password change when the force-password-change claim is set", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });

      const registerResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/register",
        payload: {
          email: "fpc@example.com",
          password: "Password123!",
          workspace_slug: "fpc-space",
          display_name: "Fpc Space"
        }
      });

      expect(registerResponse.statusCode).toBe(201);
      await pool.query("UPDATE users SET force_password_change = true WHERE email = $1", ["fpc@example.com"]);

      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/login",
        payload: {
          email: "fpc@example.com",
          password: "Password123!"
        }
      });

      expect(loginResponse.statusCode).toBe(200);
      const loggedIn = loginResponse.json() as { access_token: string };

      const blockedWorkspaceResponse = await app.inject({
        method: "GET",
        url: "/api/v2/workspace",
        headers: {
          authorization: `Bearer ${loggedIn.access_token}`
        }
      });

      expect(blockedWorkspaceResponse.statusCode).toBe(403);
      expect(blockedWorkspaceResponse.json()).toMatchObject({
        code: "password_change_required"
      });

      const meResponse = await app.inject({
        method: "GET",
        url: "/api/v2/auth/me",
        headers: {
          authorization: `Bearer ${loggedIn.access_token}`
        }
      });

      expect(meResponse.statusCode).toBe(200);

      const changePasswordResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/change-password",
        headers: {
          authorization: `Bearer ${loggedIn.access_token}`
        },
        payload: {
          current_password: "Password123!",
          next_password: "NewPassword123!"
        }
      });

      expect(changePasswordResponse.statusCode).toBe(200);
      const changed = changePasswordResponse.json() as { access_token: string; user: { force_password_change: boolean } };
      expect(changed.user.force_password_change).toBe(false);

      const workspaceResponse = await app.inject({
        method: "GET",
        url: "/api/v2/workspace",
        headers: {
          authorization: `Bearer ${changed.access_token}`
        }
      });

      expect(workspaceResponse.statusCode).toBe(200);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("verifies email tokens", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });

      const registerResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/register",
        payload: {
          email: "verify@example.com",
          password: "Password123!",
          workspace_slug: "verify-space",
          display_name: "Verify Space"
        }
      });

      expect(registerResponse.statusCode).toBe(201);
      const tokenResult = await pool.query<{ verification_token: string }>(
        "SELECT verification_token FROM users WHERE email = $1",
        ["verify@example.com"]
      );
      const token = tokenResult.rows[0]?.verification_token;
      expect(token).toBeTruthy();

      const verifyResponse = await app.inject({
        method: "GET",
        url: `/api/v2/auth/verify-email/${token}`
      });

      expect(verifyResponse.statusCode).toBe(200);
      expect(verifyResponse.json()).toMatchObject({
        user: {
          email_verified: true
        }
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("re-triggers email verification tokens", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });

      const registerResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/register",
        payload: {
          email: "retrigger@example.com",
          password: "Password123!",
          workspace_slug: "retrigger-space",
          display_name: "Retrigger Space"
        }
      });

      expect(registerResponse.statusCode).toBe(201);
      const registered = registerResponse.json() as { access_token: string };

      const firstTokenResult = await pool.query<{ verification_token: string }>(
        "SELECT verification_token FROM users WHERE email = $1",
        ["retrigger@example.com"]
      );
      const firstToken = firstTokenResult.rows[0]?.verification_token;
      expect(firstToken).toBeTruthy();

      const retriggerResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/retrigger-verification",
        headers: {
          authorization: `Bearer ${registered.access_token}`
        }
      });

      expect(retriggerResponse.statusCode).toBe(200);

      const secondTokenResult = await pool.query<{ verification_token: string }>(
        "SELECT verification_token FROM users WHERE email = $1",
        ["retrigger@example.com"]
      );
      const secondToken = secondTokenResult.rows[0]?.verification_token;
      expect(secondToken).toBeTruthy();
      expect(secondToken).not.toBe(firstToken);

      // Attempt to re-trigger for already verified user
      await pool.query("UPDATE users SET email_verified = true WHERE email = $1", ["retrigger@example.com"]);
      
      const alreadyVerifiedResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/retrigger-verification",
        headers: {
          authorization: `Bearer ${registered.access_token}`
        }
      });

      expect(alreadyVerifiedResponse.statusCode).toBe(400);
      expect(alreadyVerifiedResponse.json()).toMatchObject({
        code: "already_verified"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
