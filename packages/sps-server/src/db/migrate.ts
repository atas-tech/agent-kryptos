import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { createDbPool } from "./index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "migrations");

export interface RunMigrationsOptions {
  migrationsDir?: string;
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function appliedMigrationFiles(client: PoolClient): Promise<Set<string>> {
  const result = await client.query<{ filename: string }>("SELECT filename FROM _migrations");
  return new Set(result.rows.map((row) => row.filename));
}

export async function runMigrations(pool: Pool, options: RunMigrationsOptions = {}): Promise<string[]> {
  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const files = await listMigrationFiles(migrationsDir);
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await appliedMigrationFiles(client);
    const newlyApplied: string[] = [];

    for (const file of files) {
      if (applied.has(file)) {
        continue;
      }

      const sql = await readFile(path.join(migrationsDir, file), "utf8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`Failed to apply migration ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }

      newlyApplied.push(file);
    }

    return newlyApplied;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const pool = createDbPool();

  try {
    const applied = await runMigrations(pool);
    if (applied.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`Applied migrations: ${applied.join(", ")}`);
      return;
    }

    // eslint-disable-next-line no-console
    console.log("No migrations to apply.");
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
