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

  const schema = randomSchema("agents");
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

async function registerOwner(app: Awaited<ReturnType<typeof buildApp>>, pool: Pool | null, identity: string) {
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
  const body = response.json() as {
    access_token: string;
    user: { id: string; workspace_id: string };
  };

  if (pool) {
    await pool.query("UPDATE workspaces SET tier = 'standard' WHERE id = $1", [body.user.workspace_id]);
  }

  return body;
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
  return response.json() as { access_token: string; user: { force_password_change: boolean } };
}

describePg("agent routes", () => {
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

  it("enrolls agents, rotates keys, mints hosted JWTs, and blocks revoked credentials", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
      const owner = await registerOwner(app, pool, "agent-owner");
      await verifyOwner(app, pool, "agent-owner@example.com");

      const enrollResponse = await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          agent_id: "build-agent",
          display_name: "Build Agent"
        }
      });

      expect(enrollResponse.statusCode).toBe(201);
      const enrolled = enrollResponse.json() as {
        bootstrap_api_key: string;
        agent: { id: string; agent_id: string; status: string };
      };
      expect(enrolled.bootstrap_api_key).toMatch(/^ak_/);
      expect(enrolled.agent).toMatchObject({
        agent_id: "build-agent",
        status: "active"
      });

      const dbRow = await pool.query<{ api_key_hash: string | null }>(
        "SELECT api_key_hash FROM enrolled_agents WHERE id = $1",
        [enrolled.agent.id]
      );
      expect(dbRow.rows[0]?.api_key_hash).toEqual(expect.any(String));

      const tokenResponse = await app.inject({
        method: "POST",
        url: "/api/v2/agents/token",
        headers: {
          authorization: `Bearer ${enrolled.bootstrap_api_key}`,
          "x-forwarded-for": "203.0.113.10"
        }
      });

      expect(tokenResponse.statusCode).toBe(200);
      const tokenPayload = tokenResponse.json() as {
        access_token: string;
        agent: { workspace_id: string; agent_id: string };
      };
      expect(tokenPayload.agent).toMatchObject({
        workspace_id: owner.user.workspace_id,
        agent_id: "build-agent"
      });

      const rotateResponse = await app.inject({
        method: "POST",
        url: "/api/v2/agents/build-agent/rotate-key",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });

      expect(rotateResponse.statusCode).toBe(200);
      const rotated = rotateResponse.json() as {
        bootstrap_api_key: string;
        agent: { agent_id: string; status: string };
      };
      expect(rotated.bootstrap_api_key).toMatch(/^ak_/);
      expect(rotated.agent).toMatchObject({
        agent_id: "build-agent",
        status: "active"
      });

      const oldKeyAfterRotate = await app.inject({
        method: "POST",
        url: "/api/v2/agents/token",
        headers: {
          authorization: `Bearer ${enrolled.bootstrap_api_key}`,
          "x-forwarded-for": "203.0.113.12"
        }
      });
      expect(oldKeyAfterRotate.statusCode).toBe(401);

      const rotatedTokenResponse = await app.inject({
        method: "POST",
        url: "/api/v2/agents/token",
        headers: {
          authorization: `Bearer ${rotated.bootstrap_api_key}`,
          "x-forwarded-for": "203.0.113.13"
        }
      });
      expect(rotatedTokenResponse.statusCode).toBe(200);

      const secretRequest = await app.inject({
        method: "POST",
        url: "/api/v2/secret/request",
        headers: {
          authorization: `Bearer ${tokenPayload.access_token}`
        },
        payload: {
          public_key: "cHVi",
          description: "Hosted agent auth"
        }
      });

      expect(secretRequest.statusCode).toBe(201);

      const revokeResponse = await app.inject({
        method: "DELETE",
        url: "/api/v2/agents/build-agent",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });

      expect(revokeResponse.statusCode).toBe(200);
      expect(revokeResponse.json()).toMatchObject({
        agent: {
          agent_id: "build-agent",
          status: "revoked"
        }
      });

      const revokedTokenResponse = await app.inject({
        method: "POST",
        url: "/api/v2/agents/token",
        headers: {
          authorization: `Bearer ${rotated.bootstrap_api_key}`,
          "x-forwarded-for": "203.0.113.14"
        }
      });

      expect(revokedTokenResponse.statusCode).toBe(401);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("supports re-enrollment after revoke and rate-limits token mint attempts", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
      const owner = await registerOwner(app, pool, "reenroll-owner");
      await verifyOwner(app, pool, "reenroll-owner@example.com");

      const firstEnroll = await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          agent_id: "shared-agent"
        }
      });
      expect(firstEnroll.statusCode).toBe(201);

      const revokeResponse = await app.inject({
        method: "DELETE",
        url: "/api/v2/agents/shared-agent",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(revokeResponse.statusCode).toBe(200);

      const reenrollResponse = await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          agent_id: "shared-agent",
          display_name: "Shared Agent Reborn"
        }
      });

      expect(reenrollResponse.statusCode).toBe(201);
      expect(reenrollResponse.json()).toMatchObject({
        agent: {
          agent_id: "shared-agent",
          status: "active",
          display_name: "Shared Agent Reborn"
        }
      });

      let lastStatus = 0;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v2/agents/token",
          headers: {
            authorization: "Bearer ak_invalid_invalid_invalid_invalid",
            "x-forwarded-for": "203.0.113.22"
          }
        });
        lastStatus = response.statusCode;
      }

      expect(lastStatus).toBe(429);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("enforces workspace RBAC and protects the last active admin", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true });
      const owner = await registerOwner(app, pool, "rbac-owner");
      await verifyOwner(app, pool, "rbac-owner@example.com");

      const createViewerResponse = await app.inject({
        method: "POST",
        url: "/api/v2/members",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          email: "viewer@example.com",
          temporary_password: "ViewerTemp123!",
          role: "workspace_viewer"
        }
      });

      expect(createViewerResponse.statusCode).toBe(201);
      const createdViewer = createViewerResponse.json() as {
        member: {
          id: string;
          role: string;
          force_password_change: boolean;
        };
      };
      expect(createdViewer.member).toMatchObject({
        role: "workspace_viewer",
        force_password_change: true
      });

      const viewerLogin = await login(app, "viewer@example.com", "ViewerTemp123!");
      expect(viewerLogin.user.force_password_change).toBe(true);

      const changePasswordResponse = await app.inject({
        method: "POST",
        url: "/api/v2/auth/change-password",
        headers: {
          authorization: `Bearer ${viewerLogin.access_token}`
        },
        payload: {
          current_password: "ViewerTemp123!",
          next_password: "ViewerChanged123!"
        }
      });
      expect(changePasswordResponse.statusCode).toBe(200);
      const viewerAccessToken = (changePasswordResponse.json() as { access_token: string }).access_token;

      const viewerEnrollAttempt = await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${viewerAccessToken}`
        },
        payload: {
          agent_id: "viewer-agent"
        }
      });
      expect(viewerEnrollAttempt.statusCode).toBe(403);

      const promoteViewerResponse = await app.inject({
        method: "PATCH",
        url: `/api/v2/members/${createdViewer.member.id}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          role: "workspace_operator"
        }
      });
      expect(promoteViewerResponse.statusCode).toBe(200);
      expect(promoteViewerResponse.json()).toMatchObject({
        member: {
          role: "workspace_operator"
        }
      });

      const lastAdminResponse = await app.inject({
        method: "PATCH",
        url: `/api/v2/members/${owner.user.id}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          role: "workspace_viewer"
        }
      });

      expect(lastAdminResponse.statusCode).toBe(409);
      expect(lastAdminResponse.json()).toEqual({
        error: "The last active workspace_admin cannot be demoted, suspended, or deleted",
        code: "last_admin_lockout"
      });

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("paginates and filters workspace-scoped agent and member lists", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await buildApp({ db: pool, useInMemoryStore: true, trustProxy: true });
      const owner = await registerOwner(app, pool, "paged-owner");
      await verifyOwner(app, pool, "paged-owner@example.com");

      const otherOwner = await registerOwner(app, pool, "paged-other");
      await verifyOwner(app, pool, "paged-other@example.com");

      for (const [index, agentId] of ["agent-a", "agent-b", "agent-c"].entries()) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v2/agents",
          headers: {
            authorization: `Bearer ${owner.access_token}`
          },
          payload: {
            agent_id: agentId,
            display_name: `Agent ${index + 1}`
          }
        });

        expect(response.statusCode).toBe(201);
      }

      const revokeAgent = await app.inject({
        method: "DELETE",
        url: "/api/v2/agents/agent-b",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(revokeAgent.statusCode).toBe(200);

      const otherWorkspaceAgent = await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${otherOwner.access_token}`
        },
        payload: {
          agent_id: "other-agent"
        }
      });
      expect(otherWorkspaceAgent.statusCode).toBe(201);

      const firstAgentPage = await app.inject({
        method: "GET",
        url: "/api/v2/agents?limit=2",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(firstAgentPage.statusCode).toBe(200);
      const firstAgentPayload = firstAgentPage.json() as {
        agents: Array<{ agent_id: string }>;
        next_cursor: string | null;
      };
      expect(firstAgentPayload.agents).toHaveLength(2);
      expect(firstAgentPayload.next_cursor).toEqual(expect.any(String));
      expect(firstAgentPayload.agents.map((agent) => agent.agent_id)).toEqual(["agent-c", "agent-b"]);

      const secondAgentPage = await app.inject({
        method: "GET",
        url: `/api/v2/agents?limit=2&cursor=${encodeURIComponent(firstAgentPayload.next_cursor ?? "")}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(secondAgentPage.statusCode).toBe(200);
      const secondAgentPayload = secondAgentPage.json() as {
        agents: Array<{ agent_id: string }>;
        next_cursor: string | null;
      };
      expect(secondAgentPayload.agents.map((agent) => agent.agent_id)).toEqual(["agent-a"]);
      expect(secondAgentPayload.next_cursor).toBeNull();

      const activeAgentsOnly = await app.inject({
        method: "GET",
        url: "/api/v2/agents?status=active",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(activeAgentsOnly.statusCode).toBe(200);
      expect((activeAgentsOnly.json() as { agents: Array<{ agent_id: string }> }).agents.map((agent) => agent.agent_id)).toEqual([
        "agent-c",
        "agent-a"
      ]);

      const revokedAgentsOnly = await app.inject({
        method: "GET",
        url: "/api/v2/agents?status=revoked",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(revokedAgentsOnly.statusCode).toBe(200);
      expect((revokedAgentsOnly.json() as { agents: Array<{ agent_id: string }> }).agents.map((agent) => agent.agent_id)).toEqual([
        "agent-b"
      ]);

      const createdMembers: Array<{ id: string; email: string }> = [];
      for (const email of ["alpha@example.com", "bravo@example.com", "charlie@example.com"]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v2/members",
          headers: {
            authorization: `Bearer ${owner.access_token}`
          },
          payload: {
            email,
            temporary_password: "MemberTemp123!",
            role: "workspace_viewer"
          }
        });

        expect(response.statusCode).toBe(201);
        createdMembers.push((response.json() as { member: { id: string; email: string } }).member);
      }

      const suspendMember = await app.inject({
        method: "PATCH",
        url: `/api/v2/members/${createdMembers[1]!.id}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        },
        payload: {
          status: "suspended"
        }
      });
      expect(suspendMember.statusCode).toBe(200);

      const otherWorkspaceMember = await app.inject({
        method: "POST",
        url: "/api/v2/members",
        headers: {
          authorization: `Bearer ${otherOwner.access_token}`
        },
        payload: {
          email: "other@example.com",
          temporary_password: "OtherTemp123!",
          role: "workspace_viewer"
        }
      });
      expect(otherWorkspaceMember.statusCode).toBe(201);

      const firstMemberPage = await app.inject({
        method: "GET",
        url: "/api/v2/members?limit=2",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(firstMemberPage.statusCode).toBe(200);
      const firstMemberPayload = firstMemberPage.json() as {
        members: Array<{ email: string }>;
        next_cursor: string | null;
      };
      expect(firstMemberPayload.members).toHaveLength(2);
      expect(firstMemberPayload.next_cursor).toEqual(expect.any(String));
      expect(firstMemberPayload.members.map((member) => member.email)).toEqual([
        "charlie@example.com",
        "bravo@example.com"
      ]);

      const secondMemberPage = await app.inject({
        method: "GET",
        url: `/api/v2/members?limit=2&cursor=${encodeURIComponent(firstMemberPayload.next_cursor ?? "")}`,
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(secondMemberPage.statusCode).toBe(200);
      const secondMemberPayload = secondMemberPage.json() as {
        members: Array<{ email: string }>;
        next_cursor: string | null;
      };
      expect(secondMemberPayload.members.map((member) => member.email)).toEqual([
        "alpha@example.com",
        "paged-owner@example.com"
      ]);
      expect(secondMemberPayload.next_cursor).toBeNull();

      const activeMembersOnly = await app.inject({
        method: "GET",
        url: "/api/v2/members?status=active",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(activeMembersOnly.statusCode).toBe(200);
      expect((activeMembersOnly.json() as { members: Array<{ email: string }> }).members.map((member) => member.email)).toEqual([
        "charlie@example.com",
        "alpha@example.com",
        "paged-owner@example.com"
      ]);

      const suspendedMembersOnly = await app.inject({
        method: "GET",
        url: "/api/v2/members?status=suspended",
        headers: {
          authorization: `Bearer ${owner.access_token}`
        }
      });
      expect(suspendedMembersOnly.statusCode).toBe(200);
      expect((suspendedMembersOnly.json() as { members: Array<{ email: string }> }).members.map((member) => member.email)).toEqual([
        "bravo@example.com"
      ]);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
