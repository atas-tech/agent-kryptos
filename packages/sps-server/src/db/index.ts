import { Pool, type PoolConfig, type PoolClient } from "pg";

const DEFAULT_DATABASE_URL = "postgresql://kryptos:localdev@127.0.0.1:5433/agent_kryptos";
const DEFAULT_POOL_SIZE = 10;

export type DbExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export function resolveDatabaseUrl(): string {
  return process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
}

export function resolveDbPoolSize(): number {
  const raw = process.env.DB_POOL_SIZE?.trim();
  if (!raw) {
    return DEFAULT_POOL_SIZE;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_POOL_SIZE;
  }

  return Math.floor(parsed);
}

export function createDbPool(config: PoolConfig = {}): Pool {
  return new Pool({
    connectionString: config.connectionString ?? resolveDatabaseUrl(),
    max: config.max ?? resolveDbPoolSize(),
    ...config
  });
}
