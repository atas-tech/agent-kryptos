import { URL } from "node:url";
import { SignJWT } from "jose";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDbPool } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { buildApp } from "../src/index.js";
import { InMemoryRateLimitService } from "../src/middleware/rate-limit.js";
import { cleanupExpiredAuditRecords } from "../src/services/audit.js";

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

  const schema = randomSchema("limits");
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

async function createHostedApp(pool: Pool): Promise<App> {
  return buildApp({
    db: pool,
    useInMemoryStore: true,
    trustProxy: true,
    hmacSecret: "test-hmac",
    baseUrl: "http://localhost:3100",
    secretRegistry: [{
      secretName: "stripe.api_key.prod",
      classification: "restricted"
    }],
    exchangePolicyRules: [{
      ruleId: "stripe-prod",
      secretName: "stripe.api_key.prod",
      requesterIds: ["agent:crm-bot"],
      fulfillerIds: ["agent:payment-bot"]
    }]
  });
}

async function registerOwner(app: App, identity: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/register",
    headers: {
      "x-forwarded-for": "203.0.113.10"
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
    refresh_token: string;
    user: { workspace_id: string };
  };
}

async function verifyOwner(app: App, pool: Pool, email: string): Promise<void> {
  await pool.query("UPDATE users SET email_verified = true WHERE email = $1", [email]);
}

async function setWorkspaceTier(pool: Pool, workspaceId: string, tier: "free" | "standard"): Promise<void> {
  await pool.query("UPDATE workspaces SET tier = $2 WHERE id = $1", [workspaceId, tier]);
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

async function requestSecret(app: App, agentToken: string, description: string, ip = "198.51.100.20") {
  return app.inject({
    method: "POST",
    url: "/api/v2/secret/request",
    headers: {
      authorization: `Bearer ${agentToken}`,
      "x-forwarded-for": ip
    },
    payload: {
      public_key: "cHVibGljLWtleQ==",
      description
    }
  });
}

describePg("Milestone 6 rate limits and audit", () => {
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

  it("rate limits register, login, and hosted agent token minting with Retry-After headers", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createHostedApp(pool);

      for (let index = 0; index < 3; index += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v2/auth/register",
          headers: {
            "x-forwarded-for": "198.51.100.10"
          },
          payload: {
            email: `register-${index}@example.com`,
            password: "Password123!",
            workspace_slug: `register-${index}-space`,
            display_name: `Register ${index}`
          }
        });

        expect(response.statusCode).toBe(201);
      }

      const limitedRegister = await app.inject({
        method: "POST",
        url: "/api/v2/auth/register",
        headers: {
          "x-forwarded-for": "198.51.100.10"
        },
        payload: {
          email: "register-overflow@example.com",
          password: "Password123!",
          workspace_slug: "register-overflow-space",
          display_name: "Register Overflow"
        }
      });

      expect(limitedRegister.statusCode).toBe(429);
      expect(Number(limitedRegister.headers["retry-after"])).toBeGreaterThan(0);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v2/auth/login",
          headers: {
            "x-forwarded-for": "198.51.100.11"
          },
          payload: {
            email: "register-0@example.com",
            password: "wrong-password"
          }
        });

        expect(response.statusCode).toBe(401);
      }

      const limitedLogin = await app.inject({
        method: "POST",
        url: "/api/v2/auth/login",
        headers: {
          "x-forwarded-for": "198.51.100.11"
        },
        payload: {
          email: "register-0@example.com",
          password: "wrong-password"
        }
      });

      expect(limitedLogin.statusCode).toBe(429);
      expect(Number(limitedLogin.headers["retry-after"])).toBeGreaterThan(0);

      const ownerLogin = await app.inject({
        method: "POST",
        url: "/api/v2/auth/login",
        headers: {
          "x-forwarded-for": "198.51.100.12"
        },
        payload: {
          email: "register-0@example.com",
          password: "Password123!"
        }
      });

      expect(ownerLogin.statusCode).toBe(200);
      await verifyOwner(app, pool, "register-0@example.com");

      const createdAgent = await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${(ownerLogin.json() as { access_token: string }).access_token}`
        },
        payload: {
          agent_id: "rate-limit-agent",
          display_name: "Rate Limit Agent"
        }
      });

      expect(createdAgent.statusCode).toBe(201);
      const bootstrapApiKey = (createdAgent.json() as { bootstrap_api_key: string }).bootstrap_api_key;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v2/agents/token",
          headers: {
            authorization: `Bearer ${bootstrapApiKey}`,
            "x-forwarded-for": "198.51.100.13"
          }
        });

        expect(response.statusCode).toBe(200);
      }

      const limitedToken = await app.inject({
        method: "POST",
        url: "/api/v2/agents/token",
        headers: {
          authorization: `Bearer ${bootstrapApiKey}`,
          "x-forwarded-for": "198.51.100.13"
        }
      });

      expect(limitedToken.statusCode).toBe(429);
      expect(Number(limitedToken.headers["retry-after"])).toBeGreaterThan(0);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("throttles bursty secret-request traffic per workspace and emits a single abuse alert", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createHostedApp(pool);

      const ownerA = await registerOwner(app, "burst-owner-a");
      const ownerB = await registerOwner(app, "burst-owner-b");
      const workspaceAAgent = await issueHostedAgentToken(ownerA.user.workspace_id, "agent:burst-a");
      const workspaceBAgent = await issueHostedAgentToken(ownerB.user.workspace_id, "agent:burst-b");

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const response = await requestSecret(app, workspaceAAgent, `Burst attempt ${attempt + 1}`, "198.51.100.21");
        if (attempt < 10) {
          expect(response.statusCode).toBe(201);
        } else {
          expect(response.statusCode).toBe(429);
          expect((response.json() as { code: string }).code).toBe("quota_exceeded");
        }
      }

      const throttled = await requestSecret(app, workspaceAAgent, "Burst attempt 51", "198.51.100.21");
      expect(throttled.statusCode).toBe(429);
      expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
      expect(throttled.json()).toMatchObject({
        code: "abuse_throttled",
        limit: 1,
        threshold: 50,
        window_used: 51
      });

      const auditRows = await pool.query<{
        event_type: string;
        metadata: Record<string, unknown> | null;
      }>(
        `
          SELECT event_type, metadata
          FROM audit_log
          WHERE workspace_id = $1 AND event_type = 'abuse_alert'
          ORDER BY created_at ASC
        `,
        [ownerA.user.workspace_id]
      );

      expect(auditRows.rows).toHaveLength(1);
      expect(auditRows.rows[0]).toMatchObject({
        event_type: "abuse_alert",
        metadata: expect.objectContaining({
          scope: "secret_request",
          threshold: 50,
          used: 51,
          throttle_limit: 1
        })
      });

      const unaffectedWorkspace = await requestSecret(app, workspaceBAgent, "Other workspace request", "198.51.100.22");
      expect(unaffectedWorkspace.statusCode).toBe(201);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("self clears workspace burst throttles after the sliding hour window passes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-27T00:00:00Z"));

    try {
      const service = new InMemoryRateLimitService();

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const result = await service.consumeWorkspaceBurst(
          "workspace:burst:test-workspace:secret_request",
          50,
          60 * 60 * 1000,
          1,
          60 * 1000
        );
        expect(result.throttled).toBe(false);
      }

      const throttled = await service.consumeWorkspaceBurst(
        "workspace:burst:test-workspace:secret_request",
        50,
        60 * 60 * 1000,
        1,
        60 * 1000
      );
      expect(throttled.throttled).toBe(true);
      expect(throttled.triggerAlert).toBe(true);
      expect(throttled.windowUsed).toBe(51);

      vi.advanceTimersByTime(61 * 60 * 1000);
      const afterWindow = await service.consumeWorkspaceBurst(
        "workspace:burst:test-workspace:secret_request",
        50,
        60 * 60 * 1000,
        1,
        60 * 1000
      );
      expect(afterWindow.throttled).toBe(false);
      expect(afterWindow.triggerAlert).toBe(false);
      expect(afterWindow.windowUsed).toBe(1);
      expect(afterWindow.retryAfterSeconds).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes a workspace-scoped audit stream without logging bootstrap keys, passwords, or ciphertext", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createHostedApp(pool);

      const ownerA = await registerOwner(app, "audit-owner-a");
      await verifyOwner(app, pool, "audit-owner-a@example.com");
      await setWorkspaceTier(pool, ownerA.user.workspace_id, "standard");

      const ownerB = await registerOwner(app, "audit-owner-b");
      await verifyOwner(app, pool, "audit-owner-b@example.com");

      const memberResponse = await app.inject({
        method: "POST",
        url: "/api/v2/members",
        headers: {
          authorization: `Bearer ${ownerA.access_token}`
        },
        payload: {
          email: "operator-a@example.com",
          temporary_password: "TempPassword123!",
          role: "workspace_viewer"
        }
      });

      expect(memberResponse.statusCode).toBe(201);
      const member = memberResponse.json() as { member: { id: string } };

      const updatedMember = await app.inject({
        method: "PATCH",
        url: `/api/v2/members/${member.member.id}`,
        headers: {
          authorization: `Bearer ${ownerA.access_token}`
        },
        payload: {
          role: "workspace_operator"
        }
      });

      expect(updatedMember.statusCode).toBe(200);

      const operatorLogin = await app.inject({
        method: "POST",
        url: "/api/v2/auth/login",
        payload: {
          email: "operator-a@example.com",
          password: "TempPassword123!"
        }
      });

      expect(operatorLogin.statusCode).toBe(200);
      const operatorLoginJson = operatorLogin.json() as {
        access_token: string;
      };

      const operatorPasswordChange = await app.inject({
        method: "POST",
        url: "/api/v2/auth/change-password",
        headers: {
          authorization: `Bearer ${operatorLoginJson.access_token}`
        },
        payload: {
          current_password: "TempPassword123!",
          next_password: "OperatorPass123!"
        }
      });

      expect(operatorPasswordChange.statusCode).toBe(200);
      const operatorAccessToken = (operatorPasswordChange.json() as { access_token: string }).access_token;

      const createdAgent = await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${ownerA.access_token}`
        },
        payload: {
          agent_id: "audit-agent-a",
          display_name: "Audit Agent A"
        }
      });

      expect(createdAgent.statusCode).toBe(201);
      const bootstrapApiKey = (createdAgent.json() as { bootstrap_api_key: string }).bootstrap_api_key;

      const mintedToken = await app.inject({
        method: "POST",
        url: "/api/v2/agents/token",
        headers: {
          authorization: `Bearer ${bootstrapApiKey}`
        }
      });

      expect(mintedToken.statusCode).toBe(200);
      const agentAccessToken = (mintedToken.json() as { access_token: string }).access_token;

      const requestResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/request",
        headers: {
          authorization: `Bearer ${agentAccessToken}`
        },
        payload: {
          public_key: "cHVibGljLWtleQ==",
          description: "Need production Stripe key"
        }
      });

      expect(requestResponse.statusCode).toBe(201);
      const requestJson = requestResponse.json() as { request_id: string; secret_url: string };
      const secretUrl = new URL(requestJson.secret_url);
      const submitSig = secretUrl.searchParams.get("submit_sig");
      expect(submitSig).toEqual(expect.any(String));

      const ciphertext = "Y2lwaGVydGV4dC12YWx1ZQ==";
      const submitResponse = await app.inject({
        method: "POST",
        url: `/api/v2/secret/submit/${requestJson.request_id}?sig=${encodeURIComponent(submitSig!)}`,
        payload: {
          enc: "ZW5jLXZhbHVl",
          ciphertext
        }
      });

      expect(submitResponse.statusCode).toBe(201);

      const retrieveResponse = await app.inject({
        method: "GET",
        url: `/api/v2/secret/retrieve/${requestJson.request_id}`,
        headers: {
          authorization: `Bearer ${agentAccessToken}`
        }
      });

      expect(retrieveResponse.statusCode).toBe(200);

      const otherWorkspaceAgent = await app.inject({
        method: "POST",
        url: "/api/v2/agents",
        headers: {
          authorization: `Bearer ${ownerB.access_token}`
        },
        payload: {
          agent_id: "workspace-b-agent",
          display_name: "Workspace B Agent"
        }
      });

      expect(otherWorkspaceAgent.statusCode).toBe(201);

      const auditResponse = await app.inject({
        method: "GET",
        url: "/api/v2/audit",
        headers: {
          authorization: `Bearer ${operatorAccessToken}`
        }
      });

      expect(auditResponse.statusCode).toBe(200);
      const auditRecords = (auditResponse.json() as {
        records: Array<{
          workspace_id: string | null;
          event_type: string;
          metadata: Record<string, unknown> | null;
        }>;
      }).records;

      expect(auditRecords.length).toBeGreaterThanOrEqual(5);
      expect(new Set(auditRecords.map((record) => record.workspace_id))).toEqual(new Set([ownerA.user.workspace_id]));
      expect(auditRecords.map((record) => record.event_type)).toEqual(
        expect.arrayContaining([
          "member_created",
          "member_updated",
          "agent_enrolled",
          "request_created",
          "secret_submitted",
          "secret_retrieved"
        ])
      );

      const auditPayload = JSON.stringify(auditRecords);
      expect(auditPayload).not.toContain(bootstrapApiKey);
      expect(auditPayload).not.toContain("TempPassword123!");
      expect(auditPayload).not.toContain(ciphertext);
      expect(auditPayload).not.toContain("workspace-b-agent");

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("returns durable exchange audit history only to the caller workspace", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createHostedApp(pool);

      const ownerA = await registerOwner(app, "exchange-audit-a");
      await verifyOwner(app, pool, "exchange-audit-a@example.com");
      await setWorkspaceTier(pool, ownerA.user.workspace_id, "standard");

      const ownerB = await registerOwner(app, "exchange-audit-b");
      await verifyOwner(app, pool, "exchange-audit-b@example.com");

      const requesterToken = await issueHostedAgentToken(ownerA.user.workspace_id, "agent:crm-bot");
      const fulfillerToken = await issueHostedAgentToken(ownerA.user.workspace_id, "agent:payment-bot");

      const requestResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/request",
        headers: {
          authorization: `Bearer ${requesterToken}`
        },
        payload: {
          public_key: "cHVibGljLWtleQ==",
          secret_name: "stripe.api_key.prod",
          purpose: "Charge customers",
          fulfiller_hint: "agent:payment-bot"
        }
      });

      expect(requestResponse.statusCode).toBe(201);
      const requested = requestResponse.json() as {
        exchange_id: string;
        fulfillment_token: string;
      };

      const fulfillResponse = await app.inject({
        method: "POST",
        url: "/api/v2/secret/exchange/fulfill",
        headers: {
          authorization: `Bearer ${fulfillerToken}`
        },
        payload: {
          fulfillment_token: requested.fulfillment_token
        }
      });

      expect(fulfillResponse.statusCode).toBe(200);

      const submitResponse = await app.inject({
        method: "POST",
        url: `/api/v2/secret/exchange/submit/${requested.exchange_id}`,
        headers: {
          authorization: `Bearer ${fulfillerToken}`
        },
        payload: {
          enc: "ZW5jLXZhbHVl",
          ciphertext: "Y2lwaGVydGV4dC12YWx1ZQ=="
        }
      });

      expect(submitResponse.statusCode).toBe(201);

      const retrieveResponse = await app.inject({
        method: "GET",
        url: `/api/v2/secret/exchange/retrieve/${requested.exchange_id}`,
        headers: {
          authorization: `Bearer ${requesterToken}`
        }
      });

      expect(retrieveResponse.statusCode).toBe(200);

      const auditResponse = await app.inject({
        method: "GET",
        url: `/api/v2/audit/exchange/${requested.exchange_id}`,
        headers: {
          authorization: `Bearer ${ownerA.access_token}`
        }
      });

      expect(auditResponse.statusCode).toBe(200);
      expect((auditResponse.json() as { records: Array<{ event_type: string }> }).records.map((record) => record.event_type)).toEqual([
        "exchange_requested",
        "exchange_reserved",
        "exchange_submitted",
        "exchange_retrieved"
      ]);

      const crossWorkspaceResponse = await app.inject({
        method: "GET",
        url: `/api/v2/audit/exchange/${requested.exchange_id}`,
        headers: {
          authorization: `Bearer ${ownerB.access_token}`
        }
      });

      expect(crossWorkspaceResponse.statusCode).toBe(404);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });

  it("removes expired audit rows during retention cleanup", async () => {
    const { pool, schema } = await createIsolatedPool();

    try {
      await runMigrations(pool, { migrationsDir: migrationsDir.pathname });
      const app = await createHostedApp(pool);
      const owner = await registerOwner(app, "retention-owner");

      await pool.query(
        `
          INSERT INTO audit_log (workspace_id, event_type, actor_type, resource_id, created_at)
          VALUES
            ($1, 'member_created', 'user', 'member-old', $2),
            ($1, 'member_updated', 'user', 'member-new', $3)
        `,
        [
          owner.user.workspace_id,
          new Date("2026-01-01T00:00:00Z"),
          new Date("2026-03-10T00:00:00Z")
        ]
      );

      const deleted = await cleanupExpiredAuditRecords(pool, {
        retentionDays: 30,
        now: new Date("2026-03-12T00:00:00Z")
      });

      expect(deleted).toBe(1);

      const remaining = await pool.query<{ resource_id: string }>(
        "SELECT resource_id FROM audit_log ORDER BY resource_id"
      );
      expect(remaining.rows.map((row) => row.resource_id)).toEqual(["member-new"]);

      await app.close();
    } finally {
      await disposeIsolatedPool(pool, schema);
    }
  });
});
