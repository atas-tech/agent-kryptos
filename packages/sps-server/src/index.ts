import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSecretRoutes } from "./routes/secrets.js";
import { InMemoryRequestStore, RedisRequestStore, createRedisClient } from "./services/redis.js";
import type { RequestStore } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export interface BuildAppOptions {
  store?: RequestStore;
  hmacSecret?: string;
  baseUrl?: string;
  useInMemoryStore?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    bodyLimit: Number(process.env.SPS_BODY_LIMIT ?? 1024 * 1024),
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
  if (!store) {
    if (shouldUseInMemoryStore || process.env.NODE_ENV === "test") {
      store = new InMemoryRequestStore();
    } else {
      const client = createRedisClient();
      await client.connect();
      store = new RedisRequestStore(client);
      app.addHook("onClose", async () => {
        await client.quit();
      });
    }
  }

  await app.register(async (secretRoutesApp) => {
    await registerSecretRoutes(secretRoutesApp, {
      store,
      hmacSecret,
      requestTtlSeconds: 180,
      submittedTtlSeconds: 60,
      uiBaseUrl: process.env.SPS_UI_BASE_URL
    });
  }, { prefix: "/api/v2/secret" });


  app.get("/healthz", async () => ({ ok: true }));

  return app;
}

async function start(): Promise<void> {
  const app = await buildApp();
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
