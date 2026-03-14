import "dotenv/config";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { createDbPool } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerExchangeRoutes } from "./routes/exchange.js";
import { registerMemberRoutes } from "./routes/members.js";
import { registerSecretRoutes } from "./routes/secrets.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { InMemoryRateLimitService, RedisRateLimitService, type RateLimitService } from "./middleware/rate-limit.js";
import { cleanupExpiredAuditRecords } from "./services/audit.js";
import { StripeBillingProvider, MockBillingProvider, createStripeClient, type BillingProvider } from "./services/billing.js";
import { ExchangePolicyEngine, type ExchangePolicyRule, type SecretRegistryEntry } from "./services/policy.js";
import { InMemoryQuotaService, RedisQuotaService, type QuotaService } from "./services/quota.js";
import { InMemoryRequestStore, RedisRequestStore, createRedisClient } from "./services/redis.js";
import type { RequestStore } from "./types.js";
export interface BuildAppOptions {
  store?: RequestStore;
  quotaService?: QuotaService;
  rateLimitService?: RateLimitService;
  billingProvider?: BillingProvider;
  db?: Pool | null;
  hmacSecret?: string;
  baseUrl?: string;
  uiBaseUrl?: string; // Add this for consistency
  useInMemoryStore?: boolean;
  secretRegistry?: SecretRegistryEntry[];
  exchangePolicyRules?: ExchangePolicyRule[];
  runMigrations?: boolean;
  closeDbOnClose?: boolean;
  trustProxy?: boolean;
}

function policyRulesFromEnv(): ExchangePolicyRule[] {
  const raw = process.env.SPS_EXCHANGE_POLICY_JSON?.trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("SPS_EXCHANGE_POLICY_JSON must be a JSON array");
  }

  return parsed as ExchangePolicyRule[];
}

function secretRegistryFromEnv(): SecretRegistryEntry[] {
  const raw = process.env.SPS_SECRET_REGISTRY_JSON?.trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("SPS_SECRET_REGISTRY_JSON must be a JSON array");
  }

  return parsed as SecretRegistryEntry[];
}

function trustProxyFromEnv(): boolean {
  const raw = process.env.SPS_TRUST_PROXY?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function auditRetentionDaysFromEnv(): number {
  const raw = Number(process.env.SPS_AUDIT_RETENTION_DAYS ?? 30);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 30;
  }

  return Math.floor(raw);
}

function auditCleanupIntervalMsFromEnv(): number {
  const raw = Number(process.env.SPS_AUDIT_CLEANUP_INTERVAL_MS ?? 24 * 60 * 60 * 1000);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 24 * 60 * 60 * 1000;
  }

  return Math.floor(raw);
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  if (options.db && options.runMigrations) {
    await runMigrations(options.db);
  }

  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: Number(process.env.SPS_BODY_LIMIT ?? 1024 * 1024),
    trustProxy: options.trustProxy ?? trustProxyFromEnv(),
    ajv: {
      customOptions: {
        removeAdditional: false
      }
    }
  });

  await app.register(cors, {
    origin: true,
    credentials: false
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Referrer-Policy", "no-referrer");
    return payload;
  });

  const hmacSecret = options.hmacSecret ?? process.env.SPS_HMAC_SECRET ?? "local-dev-hmac-secret";
  const shouldUseInMemoryStore = options.useInMemoryStore ?? process.env.SPS_USE_IN_MEMORY === "1";

  if (process.env.NODE_ENV === "production" && shouldUseInMemoryStore) {
    throw new Error("In-memory store is disabled in production. Configure Redis instead.");
  }

  let store = options.store;
  let quotaService = options.quotaService;
  let rateLimitService = options.rateLimitService;
  if (!store) {
    if (shouldUseInMemoryStore || process.env.NODE_ENV === "test") {
      store = new InMemoryRequestStore();
      quotaService ??= new InMemoryQuotaService();
      rateLimitService ??= new InMemoryRateLimitService();
    } else {
      const client = createRedisClient();
      await client.connect();
      store = new RedisRequestStore(client);
      quotaService ??= new RedisQuotaService(client);
      rateLimitService ??= new RedisRateLimitService(client);
      app.addHook("onClose", async () => {
        await client.quit();
      });
    }
  }

  quotaService ??= new InMemoryQuotaService();
  rateLimitService ??= new InMemoryRateLimitService();

  const policyEngine = new ExchangePolicyEngine(
    options.secretRegistry ?? secretRegistryFromEnv(),
    options.exchangePolicyRules ?? policyRulesFromEnv()
  );

  if (options.db && options.closeDbOnClose) {
    app.addHook("onClose", async () => {
      await options.db?.end();
    });
  }

  await app.register(async (secretRoutesApp) => {
    await registerSecretRoutes(secretRoutesApp, {
      store,
      db: options.db,
      quotaService,
      hmacSecret,
      requestTtlSeconds: 180,
      submittedTtlSeconds: 60,
      uiBaseUrl: options.uiBaseUrl ?? options.baseUrl ?? process.env.SPS_UI_BASE_URL
    });
  }, { prefix: "/api/v2/secret" });

  await app.register(async (exchangeRoutesApp) => {
    await registerExchangeRoutes(exchangeRoutesApp, {
      store,
      db: options.db,
      quotaService,
      hmacSecret,
      policyEngine,
      requestTtlSeconds: 180,
      submittedTtlSeconds: 60,
      revokedTtlSeconds: 300
    });
  }, { prefix: "/api/v2/secret/exchange" });

  if (options.db) {
    await app.register(async (auditRoutesApp) => {
      await registerAuditRoutes(auditRoutesApp, { db: options.db! });
    }, { prefix: "/api/v2/audit" });

    await app.register(async (authRoutesApp) => {
      await registerAuthRoutes(authRoutesApp, {
        db: options.db!,
        rateLimitService
      });
    }, { prefix: "/api/v2/auth" });

    await app.register(async (workspaceRoutesApp) => {
      await registerWorkspaceRoutes(workspaceRoutesApp, { db: options.db! });
    }, { prefix: "/api/v2/workspace" });

    await app.register(async (agentRoutesApp) => {
      await registerAgentRoutes(agentRoutesApp, {
        db: options.db!,
        rateLimitService
      });
    }, { prefix: "/api/v2/agents" });

    await app.register(async (memberRoutesApp) => {
      await registerMemberRoutes(memberRoutesApp, { db: options.db! });
    }, { prefix: "/api/v2/members" });

    const billingProvider = options.billingProvider 
      ?? (process.env.SPS_BILLING_MOCK === "1" ? new MockBillingProvider() : new StripeBillingProvider(createStripeClient()));
    await app.register(async (billingRoutesApp) => {
      await registerBillingRoutes(billingRoutesApp, {
        db: options.db!,
        provider: billingProvider,
        quotaService
      });
    }, { prefix: "/api/v2" });

    const intervalMs = auditCleanupIntervalMsFromEnv();
    const retentionDays = auditRetentionDaysFromEnv();
    const cleanupTimer = setInterval(() => {
      void cleanupExpiredAuditRecords(options.db!, { retentionDays }).catch((error) => {
        app.log.error({ err: error }, "failed to clean up expired audit records");
      });
    }, intervalMs);
    cleanupTimer.unref();

    app.addHook("onClose", async () => {
      clearInterval(cleanupTimer);
    });
  }

  app.get("/healthz", async () => ({ ok: true }));

  return app;
}

async function start(): Promise<void> {
  const db = createDbPool();
  const app = await buildApp({
    db,
    closeDbOnClose: true,
    runMigrations: process.env.NODE_ENV !== "production"
  });
  const host = process.env.SPS_HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3100);
  await app.listen({ host, port });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
